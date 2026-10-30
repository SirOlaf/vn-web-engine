/**
 * `PackinOne.dll` (SHA-256 `5daee197…`, wamsoft's bundle of ncbind plugins, built 2014-05-19):
 * ten plugins linked into one module.
 *
 * | Bundled name        | Members                                                         |
 * | ------------------- | --------------------------------------------------------------- |
 * | `fstat.dll`         | `Storages` file functions, class `TemporaryFiles`                |
 * | `savestruct.dll`    | `Array.save2`/`saveStruct2`/`toStructString`, `Dictionary` ones |
 * | `scriptsEx.dll`     | `Scripts` object utilities, `Scripts.rehash`                    |
 * | `systemEx.dll`      | `System` registry, environment, URL and dialog functions        |
 * | `addFont.dll`       | `System.addFont`                                                 |
 * | `shrinkCopy.dll`    | `Layer.shrinkCopy`, `Layer.shrinkCopyFast`                       |
 * | `layerExBTOA.dll`   | `Layer` alpha and province functions                            |
 * | `layerExImage.dll`  | `Layer.light`, `colorize`, `modulate`, `noise`, `gaussianBlur`… |
 * | `layerExRaster.dll` | `Layer.copyRaster`                                               |
 * | `csvParser.dll`     | class `CSVParser`                                                |
 *
 * `Plugins.link` is replaced: a storage whose name (path removed, ASCII lower-cased) is one of
 * the bundled names or `packinone.dll` links as a no-op, anything else goes to the original
 * `Plugins.link`. `Plugins.PackinOneList` holds the ten bundled names. Unlinking restores the
 * original `Plugins.link` and sets `PackinOneList` to void.
 *
 * Registration follows ncbind's three phases in the binary's order; inside a phase the
 * registrations run in reverse order of the module's static constructors:
 *
 * - pre: the bundle's own callback (`PackinOneList`, the saved `Plugins.link`, the `CSVParser`
 *   global), then the CxImage notice in the important log;
 * - classes: the `Plugins.link` hook, layerExRaster, layerExImage, layerExBTOA, shrinkCopy,
 *   addFont, systemEx, `Scripts.rehash`, scriptsEx, savestruct, fstat;
 * - post: savestruct (`Array.count`), fstat (`Date` members, the attribute globals).
 *
 * `Storages.selectDirectory` reports a cancel: the folder browser (shell32) is not available.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {
  attachClass,
  attachFunction,
  detachClass,
  detachFunction,
  NcbPlugin,
  registerClass,
  unregisterClass,
  type NcbAttachDefinition,
  type NcbContext,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asObject, obj, str, VOID} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {ADVAPI32} from '../advapi32/contract.js';
import {GDI32, type Gdi32Exports} from '../gdi32/contract.js';
import {KERNEL32, type Kernel32Exports} from '../kernel32/contract.js';
import {USER32, type User32Exports} from '../user32/contract.js';
import type {Advapi32Exports} from '../advapi32/contract.js';
import {
  TJS_MEMBERENSURE,
  TJS_S_OK,
  TVP_PLUGIN,
  type Dispatch,
  type TvpFunctionExporter,
  type TvpPluginExports,
} from '../tvp-plugin/contract.js';
import {addFontPostUnregist, fontEx, FontList} from './add-font.js';
import {createCsvParserClass} from './csv-parser.js';
import {
  fstatPostRegist,
  fstatPreUnregist,
  storagesFstat,
  temporaryFiles,
  type DateMembers,
} from './fstat.js';
import {MsvcRand} from './layer-access.js';
import {layerBtoaFunctions} from './layer-btoa.js';
import {CXIMAGE_COPYRIGHT, layerExImage} from './layer-ex-image.js';
import {layerExRaster} from './layer-ex-raster.js';
import {
  arrayAdd,
  dictAdd,
  saveStructPostRegist,
  saveStructPreUnregist,
  StructWriter,
  type ArrayCount,
} from './save-struct.js';
import {scriptsAdd, scriptsRehash} from './scripts-ex.js';
import {shrinkCopyFunctions} from './shrink-copy.js';
import {systemExFunctions, type RawFunction} from './system-ex.js';

const SHA256 = '5daee197987fd21bb315223a7bccb3721cd00b550869caeb5ba82c671be9e1ff';

/** `Plugins.PackinOneList`, in the binary's order; `packinone.dll` is matched but not listed. */
export const PACKINONE_PLUGINS: readonly string[] = [
  'fstat.dll',
  'savestruct.dll',
  'scriptsEx.dll',
  'systemEx.dll',
  'addFont.dll',
  'shrinkCopy.dll',
  'layerExBTOA.dll',
  'layerExImage.dll',
  'layerExRaster.dll',
  'csvParser.dll',
];
const SELF_NAME = 'packinone.dll';

/** `tTJSString::ToLowerCase`: ASCII letters only. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

interface PackinOneServices {
  readonly kernel32: Kernel32Exports;
  readonly user32: User32Exports;
  readonly gdi32: Gdi32Exports;
  readonly advapi32: () => Advapi32Exports;
  readonly memory: () => Uint8Array;
}

/** The `Plugins` object, with a reference for the caller. */
function pluginsObject(ex: TvpFunctionExporter): Dispatch | null {
  const global = ex.TVPGetScriptDispatch();
  const slot = new VariantSlot();
  global.propGet(0, 'Plugins', slot, global);
  global.release();
  const o = asObject(slot.value);
  o?.addRef();
  slot.clear();
  return o;
}

class PackinOnePlugin extends NcbPlugin {
  /** Lower-cased names `Plugins.link` skips. */
  #names: string[] = [];
  /** The original `Plugins.link` closure. */
  #link: {object: Dispatch | null; objthis: Dispatch | null} = {object: null, objthis: null};
  #arrayClass: Dispatch | null = null;
  #undo: (() => void)[] = [];

  constructor(private readonly s: PackinOneServices) {
    super();
  }

  protected regist(ctx: NcbContext): void {
    const ex = ctx.exporter;
    const s = this.s;
    const date: DateMembers = {cls: null, setTime: null, getTime: null};
    const count: ArrayCount = {prop: null};
    const fonts = new FontList();
    const fstat = {ex, kernel32: s.kernel32};
    const undo: (() => void)[] = [];
    this.#undo = undo;
    const attach = <T extends object>(definition: NcbAttachDefinition<T>) => {
      const names = attachClass(ctx, definition);
      undo.push(() => detachClass(ctx, definition, names));
    };
    const functions = (target: string, list: readonly [string, RawFunction][]) => {
      for (const [name, body] of [...list].reverse()) {
        attachFunction(ctx, target, name, body);
        undo.push(() => detachFunction(ctx, target, name));
      }
    };

    // Pre-registration.
    this.#preRegist(ctx);
    ex.TVPAddImportantLog(CXIMAGE_COPYRIGHT);

    // Classes and functions.
    attachFunction(ctx, 'Plugins', 'link', (result, args) => this.#hookedLink(ex, result, args));
    undo.push(() => detachFunction(ctx, 'Plugins', 'link'));
    attach(layerExRaster(ex, s.memory));
    attach(layerExImage(ex, s.memory, new MsvcRand()));
    functions('Layer', layerBtoaFunctions(ex, s.memory));
    functions('Layer', shrinkCopyFunctions(s.memory));
    attach(fontEx({ex, kernel32: s.kernel32, gdi32: s.gdi32}, fonts));
    functions(
      'System',
      systemExFunctions({ex, kernel32: s.kernel32, user32: s.user32, advapi32: s.advapi32}),
    );
    functions('Scripts', [['rehash', scriptsRehash(ex)]]);
    attach(scriptsAdd(ex));
    const writer = new StructWriter(count);
    attach(dictAdd(ex, writer));
    attach(arrayAdd(ex, writer));
    const tempFiles = temporaryFiles(fstat);
    registerClass(ctx, tempFiles);
    undo.push(() => unregisterClass(ctx, tempFiles));
    attach(storagesFstat(fstat, date));

    // Post-registration.
    saveStructPostRegist(ex, count);
    fstatPostRegist(ex, date);

    // Unregistration: pre-unregistration callbacks, the registrations in the same order, then
    // the post-unregistration callbacks.
    const registrations = undo.splice(0);
    undo.push(
      () => saveStructPreUnregist(count),
      () => fstatPreUnregist(date),
      ...registrations,
      () => this.#postUnregist(ctx),
      () => addFontPostUnregist({ex, kernel32: s.kernel32, gdi32: s.gdi32}, fonts),
    );
  }

  protected unregist(): void {
    for (const step of this.#undo.splice(0)) step();
  }

  /** The bundle's pre-registration callback. */
  #preRegist(ctx: NcbContext): void {
    const ex = ctx.exporter;
    const global = ex.TVPGetScriptDispatch();
    try {
      const list = ex.TJSCreateArrayObject();
      const names = [...PACKINONE_PLUGINS, SELF_NAME];
      names.forEach((name, i) => {
        if (i < PACKINONE_PLUGINS.length) list.propSetByNum(TJS_MEMBERENSURE, i, str(name), list);
        this.#names.push(asciiLower(name));
      });
      const plugins = pluginsObject(ex);
      if (plugins) {
        plugins.propSet(TJS_MEMBERENSURE, 'PackinOneList', obj(list, list), plugins);
        const link = new VariantSlot();
        plugins.propGet(0, 'link', link, plugins);
        const v = link.value;
        if (v.type === 1) {
          v.object?.addRef();
          v.objthis?.addRef();
          this.#link = {object: v.object, objthis: v.objthis};
        }
        link.clear();
        plugins.release();
      }
      list.release();
      const array = new VariantSlot();
      global.propGet(0, 'Array', array, global);
      this.#arrayClass = asObject(array.value);
      this.#arrayClass?.addRef();
      array.clear();
      const csv = createCsvParserClass(ex, this.s.kernel32);
      global.propSet(TJS_MEMBERENSURE, 'CSVParser', obj(csv), global);
      csv.release();
    } finally {
      global.release();
    }
  }

  /** The bundle's post-unregistration callback. */
  #postUnregist(ctx: NcbContext): void {
    const ex = ctx.exporter;
    this.#names = [];
    const plugins = pluginsObject(ex);
    if (plugins) {
      plugins.propSet(TJS_MEMBERENSURE, 'PackinOneList', VOID, plugins);
      plugins.propSet(
        TJS_MEMBERENSURE,
        'link',
        obj(this.#link.object, this.#link.objthis),
        plugins,
      );
      plugins.release();
    }
    this.#link.object?.release();
    this.#link.objthis?.release();
    this.#link = {object: null, objthis: null};
    const global = ex.TVPGetScriptDispatch();
    global.deleteMember(0, 'CSVParser', global);
    global.release();
    this.#arrayClass?.release();
    this.#arrayClass = null;
  }

  #hookedLink(
    ex: TvpFunctionExporter,
    result: Parameters<RawFunction>[0],
    args: Parameters<RawFunction>[1],
  ): number {
    const first = args[0];
    if (first?.type === 2) {
      const name = asciiLower(ex.TVPExtractStorageName(first.value));
      if (this.#names.includes(name)) return TJS_S_OK;
    }
    const {object, objthis} = this.#link;
    if (!object) return ex.TVPThrowExceptionMessage('Accessing to null object');
    return object.funcCall(0, null, result, args, objthis ?? object);
  }
}

export const PACKINONE: NativeLibraryImplementation<TvpPluginExports> = {
  contract: TVP_PLUGIN,
  identities: [{kind: 'image', sha256: SHA256}],
  imports: [
    {contract: KERNEL32, binding: 'static'},
    {contract: USER32, binding: 'static'},
    {contract: GDI32, binding: 'static'},
    {contract: ADVAPI32, binding: 'delay'},
  ],
  link(context) {
    const kernel32 = context.staticImport(KERNEL32);
    const user32 = context.staticImport(USER32);
    const gdi32 = context.staticImport(GDI32);
    const advapi32 = context.delayImport(ADVAPI32);
    const memory = context.process.memory;
    return {
      exports: new PackinOnePlugin({kernel32, user32, gdi32, advapi32, memory: () => memory.u8}),
    };
  },
};
