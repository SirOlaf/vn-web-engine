import type {NifPool} from '../../compiler/nif/pool.js';
import {corePreprocessorValues, type Tjs2CompilerOptions} from './tjs2/compiler.js';
import {defaultTjs2Messages, readTjs2Messages} from './tjs2/messages.js';

/** A Kirikiri core build, identified by the SHA-256 of its executable. */
export interface KirikiriCoreRevision {
  readonly sha256: string;
  /** The executable's FileVersion, dotted. */
  readonly fileVersion: string;
  /** `TVPCompileDate` and `TVPCompileTime` (`__DATE__`, `__TIME__` of the build). */
  readonly compileDate: string;
  readonly compileTime: string;
  /** TJS version, as the TJS dump routine prints it (`TJS version %d.%d.%d`). */
  readonly tjsVersion: readonly [major: number, minor: number, release: number];
  /** `tjsEnableDicFuncQuickHack`: the digit in the core's dicfunc marker string. */
  readonly dicFuncQuickHack: boolean;
  /** Preprocessor values the core defines before the first script, besides `version`. */
  readonly preprocessorValues: readonly (readonly [string, number])[];
  /**
   * `TVPInitTJSScript`: the narrow, NUL-terminated script of constants (`bsNone`, `VK_*`,
   * `gcsAuto`, `imageTagLayerType`, …) the core runs before registering its classes.
   */
  readonly initScriptAddress: number;
  /**
   * The function exporter's name table (`TVPInitExportFuncs`): a zlib blob at `address` (VA)
   * inflating to NUL-terminated C++ signatures, one per exported function.
   */
  readonly exporterNames: {
    readonly address: number;
    readonly compressedSize: number;
    readonly size: number;
    readonly count: number;
  };
}

/**
 * NEKOPARA Vol. 1 (`nekopara_vol1.exe`, Kirikiri Z): TJS 2.4.28 (dump routine 0x471d50),
 * `kirikiriz = 1` (`TVPInitScriptEngine` → 0x472390), dicfunc marker " - 0 <- Put '1' to
 * enable dicfunc quick-hack - " at 0x769a80.
 */
const NEKOPARA_VOL1: KirikiriCoreRevision = {
  sha256: '0b81a3c90a46d3447766af1d7f408b3a4aa1b8eda5cd7edbf33429b1f8c36815',
  fileVersion: '1.2.0.3',
  // UTF-16 strings at 0x6e329c and 0x6e3318, used by TVPGetVersionInformation (0x44f7a0).
  compileDate: 'Nov 18 2014',
  compileTime: '17:23:21',
  tjsVersion: [2, 4, 28],
  dicFuncQuickHack: false,
  preprocessorValues: [['kirikiriz', 1]],
  // TVPInitScriptEngine (0x407010) runs it first.
  initScriptAddress: 0x6d9388,
  // TVPInitExportFuncs (0x420550) inflates 0x768538 and pairs the names with 0x767b10.
  exporterNames: {address: 0x768538, compressedSize: 0x13df, size: 0xa405, count: 649},
};

export const KIRIKIRI_CORE_REVISIONS: ReadonlyMap<string, KirikiriCoreRevision> = new Map([
  [NEKOPARA_VOL1.sha256, NEKOPARA_VOL1],
]);

/** How the core was started and where it runs; decides some compiler behaviour. */
export interface KirikiriCoreEnvironment {
  /** The user's UI language (LANGID); selects the message string table. */
  readonly uiLanguage: number;
  /** The core executable, to read its message tables; built-in texts otherwise. */
  readonly executable?: Uint8Array;
  /** `-unaryaster=compat`. */
  readonly unaryAsteriskIgnoresPropAccess?: boolean;
  /** `-evalcontext=global`. */
  readonly evalOperatorIsOnGlobal?: boolean;
}

/** Compiler options of a core: a fresh engine-wide preprocessor state and the build flags. */
export function tjs2CompilerOptions(
  revision: KirikiriCoreRevision,
  environment: KirikiriCoreEnvironment,
  pool?: NifPool,
): Tjs2CompilerOptions {
  return {
    preprocessor: corePreprocessorValues(revision.tjsVersion, revision.preprocessorValues),
    dicFuncQuickHack: revision.dicFuncQuickHack,
    messages: environment.executable
      ? readTjs2Messages(environment.executable, environment.uiLanguage)
      : defaultTjs2Messages(environment.uiLanguage),
    unaryAsteriskIgnoresPropAccess: environment.unaryAsteriskIgnoresPropAccess,
    evalOperatorIsOnGlobal: environment.evalOperatorIsOnGlobal,
    pool,
  };
}
