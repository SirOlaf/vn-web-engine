/**
 * `KAGParserEx.dll` (SHA-256 `4c8d3734…`, built 2011-08-15 from wamsoft KAGParserEx at
 * `6810447`, "パラメータマクロ機能"): the kirikiri 2 KAG parser as a `tp_stub` native class
 * that replaces the global `KAGParser`. The reference core has no `KAGParser` of its own, so
 * nothing is saved at link time and unlinking only removes the class.
 *
 * Extensions over the kirikiri 2 parser: `multiLineTagEnabled` (a tag continues after a
 * trailing ` \` on a next line that starts with `;`), `taglist` in every tag dictionary
 * (attribute names in order), parameter macros (`paramMacros`, `[pmacro]`, `[erasepmacro]`).
 *
 * Members, in registration order (`0x10013f80`): `finalize`, the constructor, `loadScenario`,
 * `goToLabel`, `callLabel`, `getNextTag`, `assign`, `clear`, `store`, `restore`,
 * `clearCallStack`, `popMacroArgs`, `interrupt`, `resetInterrupt`; properties `curLine`,
 * `curPos`, `curLineStr`, `processSpecialTags`, `ignoreCR`, `debugLevel`, `macros`,
 * `paramMacros`, `macroParams`, `mp` (the same getter), `callStackDepth`, `curStorage`,
 * `curLabel`, `multiLineTagEnabled`.
 *
 * Error messages come from the core's message map (`TVPKAGSyntaxError`, …). The reference
 * build's map has no KAG messages, so these errors carry the empty message there, as natively.
 * The scenario cache registers a compact-event hook on first use (cleared at
 * `TVP_COMPACT_LEVEL_DEACTIVATE`) and keeps it after unlinking, as the native module does.
 * The plugin creates no plugin-side TJS objects, so `V2Unlink` never refuses.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asBoolean,
  asInt32,
  asObject,
  asString,
  bool,
  int,
  obj,
  str,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {runPluginRoutine} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {
  failed,
  NIT_METHOD,
  NIT_PROPERTY,
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_MEMBERENSURE,
  TJS_NIS_GETINSTANCE,
  TJS_S_OK,
  TVP_PLUGIN,
  type Dispatch,
  type NativeClassObject,
  type NativeInstance,
  type Out,
  type TvpFunctionExporter,
  type TvpPluginExports,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';
import {getScenario, KagParserInstance, SOURCE_FILE, type KagContext} from './parser.js';
import {ScenarioCache} from './scenario.js';

const SHA256 = '4c8d3734d834022ea21d2e9e19626a25bd5bcf96ae2371cb941269f787d50524';
const CLASS_NAME = 'KAGParser';
/** `TVP_COMPACT_LEVEL_DEACTIVATE`. */
const COMPACT_LEVEL_DEACTIVATE = 10;

/**
 * `tTJSNI_KAGParser::initMethod`: `clear`/`assign` of `Dictionary` and `clear`/`assign`/`push`
 * of `Array`, with a reference each. The lines are those of the binary's internal errors.
 */
function initMethods(ex: TvpFunctionExporter): Dispatch[] {
  const classOf = (name: string) => {
    const v = new VariantSlot();
    ex.TVPExecuteExpression(name, null, v);
    const o = asObject(v.value)!;
    v.clear();
    return o;
  };
  const dictclass = classOf('Dictionary');
  const arrayclass = classOf('Array');
  const methods: Dispatch[] = [];
  try {
    for (const [cls, name, line] of [
      [dictclass, 'clear', 342],
      [dictclass, 'assign', 346],
      [arrayclass, 'clear', 350],
      [arrayclass, 'assign', 354],
      [arrayclass, 'push', 358],
    ] as const) {
      const val = new VariantSlot();
      if (failed(cls.propGet(0, name, val, cls)))
        ex.TVPThrowExceptionMessage(
          ex.TJSGetMessageMapMessage('TVPInternalError'),
          SOURCE_FILE,
          String(line),
        );
      const m = asObject(val.value)!;
      m.addRef();
      val.clear();
      methods.push(m);
    }
  } catch (e) {
    for (const m of methods) m.release();
    throw e;
  }
  return methods;
}

/** `tTJSNC_KAGParser::CreateNativeClass`: the class object, owned by the caller. */
function createKagParserClass(k: KagContext): NativeClassObject {
  const ex = k.ex;
  const cls = ex.TJSCreateNativeClassForPlugin(CLASS_NAME, () => new KagParserInstance(k));
  const classId = ex.TJSRegisterNativeClass(CLASS_NAME);
  ex.TJSNativeClassSetClassID(cls, classId);

  const ni = (objthis: Dispatch | null): KagParserInstance | null => {
    if (!objthis) return null;
    const p: Out<NativeInstance | null> = {value: null};
    if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, p))) return null;
    return p.value as KagParserInstance | null;
  };
  const register = (name: string, dsp: Dispatch, type = NIT_METHOD) =>
    ex.TJSNativeClassRegisterNCM(cls, name, dsp, CLASS_NAME, type, 0);
  const method = (
    name: string,
    body: (
      self: KagParserInstance,
      result: VariantResult | null,
      args: readonly Variant[],
    ) => number,
  ) =>
    register(
      name,
      ex.TJSCreateNativeClassMethod((result, args, objthis) => {
        const self = ni(objthis);
        if (!self) return TJS_E_NATIVECLASSCRASH;
        return body(self, result, args);
      }),
    );
  const property = (
    name: string,
    get: (self: KagParserInstance) => Variant,
    set: ((self: KagParserInstance, value: Variant) => number) | null = null,
  ) =>
    register(
      name,
      ex.TJSCreateNativeClassProperty(
        (result, objthis) => {
          const self = ni(objthis);
          if (!self) return TJS_E_NATIVECLASSCRASH;
          result.set(get(self));
          return TJS_S_OK;
        },
        set &&
          ((value, objthis) => {
            const self = ni(objthis);
            if (!self) return TJS_E_NATIVECLASSCRASH;
            return set(self, value);
          }),
      ),
      NIT_PROPERTY,
    );
  const nullable = (d: Dispatch | null) => obj(d, d);
  const done = () => TJS_S_OK;

  register(
    'finalize',
    ex.TJSCreateNativeClassMethod(() => TJS_S_OK),
  );
  register(
    CLASS_NAME,
    ex.TJSCreateNativeClassConstructor((_result, args, objthis) => {
      const self = ni(objthis);
      if (!self || !objthis) return TJS_E_NATIVECLASSCRASH;
      return self.construct(args, objthis);
    }),
  );
  method('loadScenario', (self, _result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    return runPluginRoutine(self.loadScenario(asString(args[0]!)), done);
  });
  method('goToLabel', (self, _result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    self.goToLabel(asString(args[0]!));
    return TJS_S_OK;
  });
  method('callLabel', (self, _result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    self.callLabel(asString(args[0]!));
    return TJS_S_OK;
  });
  method('getNextTag', (self, result) =>
    runPluginRoutine(self.getNextTag(), (dsp) => {
      if (!dsp) {
        result?.clear(); // void, not null
      } else {
        result?.set(obj(dsp, dsp));
        dsp.release();
      }
      return TJS_S_OK;
    }),
  );
  method('assign', (self, _result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const src = args[0]!.type === 1 ? ni(args[0]!.object) : null;
    if (!src)
      return ex.TVPThrowExceptionMessage(ex.TJSGetMessageMapMessage('TVPKAGSpecifyKAGParser'));
    self.assignFrom(src);
    return TJS_S_OK;
  });
  method('clear', (self) => {
    self.clear();
    return TJS_S_OK;
  });
  method('store', (self, result) => {
    const dsp = self.store();
    result?.set(obj(dsp, dsp));
    dsp.release();
    return TJS_S_OK;
  });
  method('restore', (self, _result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const dsp = asObject(args[0]!);
    if (!dsp) return ex.TVPThrowExceptionMessage(ex.TJSGetMessageMapMessage('TJSNullAccess'));
    return runPluginRoutine(self.restore(dsp), done);
  });
  method('clearCallStack', (self) => {
    self.clearCallStack();
    return TJS_S_OK;
  });
  method('popMacroArgs', (self) => {
    self.popMacroArgs();
    return TJS_S_OK;
  });
  method('interrupt', (self) => {
    self.interrupt();
    return TJS_S_OK;
  });
  method('resetInterrupt', (self) => {
    self.resetInterrupt();
    return TJS_S_OK;
  });

  property('curLine', (self) => int(self.curLine));
  property('curPos', (self) => int(self.curPos));
  property('curLineStr', (self) => str(self.curLineStr));
  property(
    'processSpecialTags',
    (self) => bool(self.processSpecialTags),
    (self, v) => {
      self.processSpecialTags = asBoolean(v);
      return TJS_S_OK;
    },
  );
  property(
    'ignoreCR',
    (self) => bool(self.ignoreCR),
    (self, v) => {
      self.ignoreCR = asBoolean(v);
      return TJS_S_OK;
    },
  );
  property(
    'debugLevel',
    (self) => int(self.debugLevel),
    (self, v) => {
      self.debugLevel = asInt32(v);
      return TJS_S_OK;
    },
  );
  property('macros', (self) => nullable(self.macros));
  property('paramMacros', (self) => nullable(self.paramMacros));
  property('macroParams', (self) => nullable(self.macroTop()));
  property('mp', (self) => nullable(self.macroTop()));
  property('callStackDepth', (self) => int(self.callStackDepth));
  property(
    'curStorage',
    (self) => str(self.storageName),
    (self, v) => runPluginRoutine(self.loadScenario(asString(v)), done),
  );
  property('curLabel', (self) => str(self.curLabel));
  property(
    'multiLineTagEnabled',
    (self) => bool(self.multiLineTagEnabled),
    (self, v) => {
      self.multiLineTagEnabled = asBoolean(v);
      return TJS_S_OK;
    },
  );
  return cls;
}

class KagParserExPlugin implements TvpPluginExports {
  #ex: TvpFunctionExporter | null = null;
  #methods: Dispatch[] = [];
  #origKagParser: Dispatch | null = null;
  /** The module's scenario cache and whether its compact hook is installed (static). */
  readonly #cache = new ScenarioCache();
  #compactHooked = false;

  v2Link(exporter: TvpFunctionExporter): number {
    const ex = (this.#ex = exporter);
    const methods = (this.#methods = initMethods(ex));
    const cache = this.#cache;
    const [dicClear, dicAssign, arrayClear, arrayAssign, arrayPush] = methods as [
      Dispatch,
      Dispatch,
      Dispatch,
      Dispatch,
      Dispatch,
    ];
    const k: KagContext = {
      ex,
      dicClear,
      dicAssign,
      arrayClear,
      arrayAssign,
      arrayPush,
      cache,
      getScenario: (name, isString) => {
        if (!this.#compactHooked) {
          ex.TVPAddCompactEventHook({
            onCompact: (level) => {
              if (level >= COMPACT_LEVEL_DEACTIVATE) cache.clear();
            },
          });
          this.#compactHooked = true;
        }
        return getScenario(ex, cache, name, isString);
      },
    };

    const global = ex.TVPGetScriptDispatch();
    const val = new VariantSlot();
    if (!failed(global.propGet(0, CLASS_NAME, val, global))) {
      this.#origKagParser = asObject(val.value);
      this.#origKagParser?.addRef();
      val.clear();
    }
    const cls = createKagParserClass(k);
    global.propSet(TJS_MEMBERENSURE, CLASS_NAME, obj(cls), global);
    cls.release();
    global.release();
    return TJS_S_OK;
  }

  v2Unlink(): number {
    const ex = this.#ex!;
    const global = ex.TVPGetScriptDispatch();
    global.deleteMember(0, CLASS_NAME, global);
    const orig = this.#origKagParser;
    if (orig) {
      this.#origKagParser = null;
      global.propSet(TJS_MEMBERENSURE, CLASS_NAME, obj(orig), global);
      orig.release();
    }
    global.release();
    // doneMethod
    for (const m of this.#methods.splice(0).reverse()) m.release();
    this.#ex = null;
    return TJS_S_OK;
  }
}

export const KAGPARSEREX: NativeLibraryImplementation<TvpPluginExports> = {
  contract: TVP_PLUGIN,
  identities: [{kind: 'image', sha256: SHA256}],
  imports: [],
  link() {
    return {exports: new KagParserExPlugin()};
  },
};
