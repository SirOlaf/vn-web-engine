import {
  Lua51,
  LuaRuntimeError,
  luaText,
  luaFileBytes,
  type LuaReference,
  type LuaTable,
  type LuaValue,
  type LuaThread,
  type LuaThreadResult,
} from '../../core/lua51/runtime.js';
import {ArtemisEvents} from './events.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {PointerPositionHost} from '../../input/cursor-host.js';
import {windowsTextFileBytes} from '../../platform/windows-text-file.js';
import {decodeCp932, encodeCp932} from '../../text/cp932.js';
import {readArtemisPngComments} from './png-comments.js';
import {installArtemisLuaOs, type ArtemisLuaOsHost} from './lua-os.js';
import {artemisEmoteLuaPrelude, callArtemisEmotePlayer} from './emote-lua.js';
import type {EmotePlayer} from '../../native/emotedriver/player.js';

/** `createEmoteLayer` arguments after luabind's type filter (0x140151480). */
export interface ArtemisEmoteLayerRequest {
  readonly id: string;
  readonly files: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly progress: boolean;
}
/** The Rev.3258 E-mote layer methods of the Lua `engine` object. */
export interface ArtemisLuaEmoteHost {
  /** `getEmoteVersion` (0x1401535d0): `EmoteGetSDKVersion`, a newline, then
   * `EmoteGetBuildDateTime`. */
  readonly version: string;
  /** Creates the layer and returns its player; 'missing' when a file does not exist, and
   * 'suspended' while files are read (the call is repeated on resume). */
  createLayer(request: ArtemisEmoteLayerRequest): EmotePlayer | 'missing' | 'suspended';
  /** The player of the current actor at `id`. */
  layer(id: string): EmotePlayer | 'not-found' | 'not-emote';
}

export interface ArtemisLuaHost {
  /** Synchronous prepared byte sources; null means the file does not exist. */
  readFile(path: string): Uint8Array | null;
  /** Host compatibility policy for compiled includes only; raw file reads stay native. */
  prepareIncludeSource?(path: string, bytes: Uint8Array): Uint8Array;
  /** Optional prepared CFile owner. Include tries luaL_loadfile here before
   * retrying the normal loose-first CArtemisPackFile read on any failure.
   */
  readPlainFile?(path: string): Uint8Array | null;
  /** Native12d080 level1 reporting returns to the include caller. The concrete
   * owner supplies logging/debug policy; absent owner retains diagnostic refusal.
   */
  reportIncludeError?(path: string, error: unknown): void;
  fileExists(path: string): boolean;
  now(): number;
  /** Rev.2868 0x5a2300 checks the script debug mode before inspecting arguments. */
  debugMode?(): number;
  /** The platform behind the Lua `os` library (lua-os.ts); without it `os.execute` and
   * `os.getenv` are refused. */
  os?: ArtemisLuaOsHost;
  /** Wall clock in milliseconds since the Unix epoch for `os.date`/`os.time` (CRT
   * `time`); defaults to `Date.now`. */
  wallClock?(): number;
  tag(tag: AsbTag): void | 'suspended';
  /** Opt in only when callbacks run through createCall and the owner drives yielded work. */
  suspendableTags?: boolean;
  enqueueTag(tag: AsbTag): void;
  variable(name: string): string | Uint8Array;
  setMagicPath?(name: string, root: string): void;
  setTouchLimit?(limit: number): void;
  pointerPosition?: PointerPositionHost;
  /** 0x140134180: the manager's ordinary foreground load (virtual +8) whose lease is dropped
   * at once. A pending decode suspends the calling coroutine like a resource tag. */
  bindSurface?(path: string): void | 'suspended';
  /** Actual native mode1 preload request owner; call returns without waiting for decode. */
  bindSurfaceAsync?(path: string): void;
  /** Cancel a queued binding or release a completed named native binding. */
  unbindSurface?(path: string): void;
  clearSurfaceLoadQueue?(): void;
  /** Missing/non-string Lua argument queries the whole queue; a string queries its name. */
  isLoadingSurface?(path?: string): boolean;
  scriptStack?(): readonly import('./script.js').ArtemisScriptStackFrame[];
  /** Lua `random` (0x14012eb30): the script's uniform [0, 0xffff] sample (ArtemisRandom). */
  random?(): number;
  /** Lua `getScriptWaitReason` (0x1401315b0): the script wait flags (ArtemisTimedWait.reason). */
  scriptWaitReason?(): {
    readonly time?: number;
    readonly textTween?: true;
    readonly textClearTween?: true;
    readonly sound?: Uint8Array;
    readonly video?: Uint8Array;
  };
  /** Blocking CArtemisPackFile read used by `loadPngComments`; null is an open failure. A
   * pending read suspends the calling coroutine and the call is repeated on resume. */
  readResource?(path: string): Uint8Array | null | 'suspended';
  /** 0x14012d490 level 1 report of a native Shift-JIS message (converted only when the
   * script text mode +0xaf0 is nonzero, which this owner does not model). */
  reportError?(message: Uint8Array): void;
  /** CArtemisInput queries and `overrideKey` (ArtemisInput). */
  input?: Pick<import('./input.js').ArtemisInput, 'query' | 'override'>;
  /** Lua `getScriptStatus`/`setScriptStatus` (0x140131480): run mode c70 of the current
   * caret; the setter stores c74 = c70, c70 = `mode`. */
  scriptStatus?(): number;
  setScriptStatus?(mode: number): void;
  /** Lua `getFrameNumber`: the frame counter +0xf0. */
  frameNumber?(): number;
  /** The touch device: `getTouchCount` (virtual +0x18) and `setUseTouchHold` (+0x30). */
  touch?: {count(): number; setHold(enabled: boolean): void};
  restoreFontCache?(path: string): void | 'suspended';
  /** E-mote layers (Rev.3258); requires `suspendableTags` and `reportError`. */
  emote?: ArtemisLuaEmoteHost;
}
// 0x140375c08, 0x140375b78 and 0x140375ba8 (Shift-JIS).
const sjis = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
const pngCommentsPrefix = '6c6f6164506e67436f6d6d656e7473';
export const artemisLuaErrors = {
  pngCommentsArgument: sjis(pngCommentsPrefix + '82cc88f8909482aa957390b382c582b7'),
  pngCommentsMissing: sjis(
    pngCommentsPrefix + '82c591ce8fdb82cc837483408343838b82aa8ca982c282a982e882dc82b982f1',
  ),
  pngCommentsUnreadable: sjis(
    pngCommentsPrefix +
      '82c591ce8fdb82cc837483408343838b82a982e7835283818393836782f093c782dd8d9e82df82dc82b982f1',
  ),
  // 0x1403870d0, 0x140387188, 0x1403871e0.
  emoteFileMissing: sjis(
    '637265617465456d6f74654c6179657282c591ce8fdb82cc837483408343838b82aa8ca982c282a982e882dc82b982f1',
  ),
  layerNotFound: sjis('8e7792e882b382ea82bd838c83438384815b82aa8ca982c282a982e882dc82b982f1'),
  notEmoteLayer: sjis(
    '8e7792e882b382ea82bd838c83438384815b82cd452d6d6f7465838c83438384815b82c582cd82a082e882dc82b982f1',
  ),
} as const;
// `<name>の引数が不正です` (0x140375910..0x140375d68).
const argumentError = (name: string) =>
  sjis(
    [...new TextEncoder().encode(name)].map((byte) => byte.toString(16).padStart(2, '0')).join('') +
      '82cc88f8909482aa957390b382c582b7',
  );
/** luabind number conversion to a native int (cvttsd2si: out of range is 0x80000000). */
const nativeInt = (value: number) =>
  Number.isFinite(value) && Math.abs(value) < 2 ** 31 ? Math.trunc(value) : -0x80000000;

/** Rev.3179 CLua's confirmed byte-string and tag bridge. Unbound methods fail. */
export class ArtemisLua {
  readonly vm: Lua51;
  readonly events: ArtemisEvents;
  private filter: LuaReference | undefined;
  private eventFilter: LuaReference | undefined;
  constructor(
    private readonly host: ArtemisLuaHost,
    instructionLimit?: number,
  ) {
    this.vm = new Lua51(instructionLimit);
    this.events = new ArtemisEvents((name, args) => this.call(name, args));
    this.vm.bindReferences('debug', () => {
      // Native release mode returns before type checking or LogFilter/output work.
      // Keep enabled debug output explicit until its console/filter owner exists.
      if ((host.debugMode?.() ?? 0) !== 0)
        throw new Error('Unsupported Artemis enabled debug console');
      return [];
    });
    // Rev.2601 4f6300: string fields only, byte-preserving std::string source.
    // The Japanese codecs are shared text services, not game-specific conversions.
    this.vm.bind('convertEncoding', (args) => {
      const invalid = () => {
        const message = argumentError('convertEncoding');
        if (!host.reportError) throw Error('Invalid Artemis convertEncoding arguments');
        host.reportError(message);
        return [null];
      };
      const table = args[0];
      if (!(table instanceof Map)) return invalid();
      const fields = new Map<string, Uint8Array>();
      for (const [key, value] of table)
        if (typeof key === 'string' && value instanceof Uint8Array)
          fields.set(key.split('\0', 1)[0]!, value);
      const from = luaText(fields.get('from'));
      const to = luaText(fields.get('to'));
      if (!['sjis', 'utf8', 'euc', 'jis'].includes(to)) return invalid();
      // Native also exposes EUC/JIS and automatic input detection. Keep those
      // explicit refusals until their conversion tables and detector are modeled.
      if (!['sjis', 'utf8'].includes(from) || !['sjis', 'utf8'].includes(to))
        throw Error('Unsupported Artemis convertEncoding codec or automatic detection');
      const source = fields.get('source') ?? new Uint8Array();
      if (from === to) return [source.slice()];
      return [
        from === 'sjis'
          ? new TextEncoder().encode(decodeCp932(source))
          : encodeCp932(new TextDecoder().decode(source)),
      ];
    });
    this.vm.bind('setEventHandler', (args) => {
      const table = args[0];
      if (!(table instanceof Map)) throw new Error('Expected Artemis event handler table');
      const entries: [string, string][] = [];
      for (const [key, value] of table)
        if (typeof key === 'string' && value instanceof Uint8Array)
          entries.push([key, luaText(value)]);
      this.events.register(entries);
      return [];
    });
    this.vm.bindReferences('setTagFilter', (args) => {
      const table = args[0];
      if (!table || table.type !== 5) throw new Error('Expected Artemis tag filter table');
      const next = table.retain();
      this.filter?.release();
      this.filter = next;
      return [];
    });
    this.vm.bindReferences('setEventFilter', (args) => {
      const callback = args[0];
      if (!callback || callback.type !== 6)
        throw new Error('Expected Artemis event filter function');
      const next = callback.retain();
      this.eventFilter?.release();
      this.eventFilter = next;
      return [];
    });
    if (host.setMagicPath)
      this.vm.bind('setMagicPath', (args) => {
        const table = args[0];
        if (!(table instanceof Map)) throw new Error('Expected Artemis magic path tuple');
        let name = '',
          root = '';
        for (const [key, value] of table) {
          if (typeof key !== 'number' || !(value instanceof Uint8Array)) continue;
          if (Math.trunc(key) === 1) name = luaText(value);
          if (Math.trunc(key) === 2) root = luaText(value);
        }
        host.setMagicPath!(name, root);
        return [];
      });
    if (host.setTouchLimit)
      this.vm.bind('setUseMultiTouch', (args) => {
        const number = args[0];
        if (
          typeof number !== 'number' ||
          !Number.isFinite(number) ||
          Math.trunc(number) < -0x80000000 ||
          Math.trunc(number) > 0x7fffffff
        )
          throw new Error('Unsupported Artemis touch limit');
        host.setTouchLimit!(Math.trunc(number));
        return [];
      });
    if (host.bindSurface)
      this.vm.bind('bindSurface', (args) => {
        const value = args[0];
        if (!(value instanceof Uint8Array)) throw Error('Expected Artemis surface name string');
        const nul = value.indexOf(0);
        if (host.bindSurface!(luaText(nul < 0 ? value : value.subarray(0, nul))) === 'suspended') {
          if (!host.suspendableTags)
            throw new Error('Artemis surface load suspension requires a coroutine owner');
          return [true];
        }
        return [];
      });
    if (host.bindSurfaceAsync)
      this.vm.bind('bindSurfaceAsync', (args) => {
        const value = args[0];
        if (!(value instanceof Uint8Array)) throw Error('Expected Artemis surface name string');
        const nul = value.indexOf(0);
        host.bindSurfaceAsync!(luaText(nul < 0 ? value : value.subarray(0, nul)));
        return [];
      });
    if (host.unbindSurface)
      this.vm.bind('unbindSurface', (args) => {
        const value = args[0];
        if (!(value instanceof Uint8Array)) throw Error('Expected Artemis surface name string');
        const nul = value.indexOf(0);
        host.unbindSurface!(luaText(nul < 0 ? value : value.subarray(0, nul)));
        return [];
      });
    if (host.clearSurfaceLoadQueue)
      this.vm.bind('clearSurfaceLoadQueue', () => {
        host.clearSurfaceLoadQueue!();
        return [];
      });
    if (host.isLoadingSurface)
      this.vm.bind('isLoadingSurface', (args) => {
        const value = args[0];
        let path: string | undefined;
        if (value instanceof Uint8Array) {
          const nul = value.indexOf(0);
          path = luaText(nul < 0 ? value : value.subarray(0, nul));
        }
        const loading = host.isLoadingSurface!(path);
        if (typeof loading !== 'boolean') throw Error('Expected Artemis surface loading boolean');
        return [loading];
      });
    if (host.scriptStack)
      // 0x1401318a0: {file, index, reservedCommands = {[n] = {command, line, parameter}}} per
      // caret; byte strings keep exact tag argument bytes.
      this.vm.bind('getScriptStack', () => {
        const encoder = new TextEncoder(),
          stack: LuaTable = new Map();
        host.scriptStack!().forEach((frame, position) => {
          const commands: LuaTable = new Map();
          frame.commands.forEach((tag, offset) => {
            const parameter: LuaTable = new Map();
            for (const [key, value] of tag.args)
              parameter.set(key, tag.bytes?.get(key) ?? encoder.encode(value));
            commands.set(
              frame.firstCommand + offset,
              new Map<string, LuaValue>([
                ['command', encoder.encode(tag.name)],
                ['line', tag.sourceLine],
                ['parameter', parameter],
              ]),
            );
          });
          stack.set(
            position + 1,
            new Map<string, LuaValue>([
              ['file', encoder.encode(frame.file)],
              ['index', frame.index],
              ['reservedCommands', commands],
            ]),
          );
        });
        return [stack];
      });
    if (host.pointerPosition)
      this.vm.bind('getMousePoint', () => {
        // 134ca0 reads the provider twice, stores each coordinate as float32,
        // then 138f10 widens it to the Lua number. No integer truncation.
        const coordinate = (value: number) => {
          if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
            throw new Error('Invalid Artemis pointer position');
          return Math.fround(value);
        };
        const x = coordinate(host.pointerPosition!.readPointerPosition().x);
        const y = coordinate(host.pointerPosition!.readPointerPosition().y);
        return [
          new Map<string, LuaValue>([
            ['x', x],
            ['y', y],
          ]),
        ];
      });
    this.vm.bind('now', () => [Math.trunc(host.now()) & 0x7fffffff]);
    if (host.input && host.reportError) {
      const input = host.input;
      // Each query takes a Lua number (type 3); another argument reports and returns nil.
      for (const [name, kind] of [
        ['isPush', 'push'],
        ['isDown', 'down'],
        ['isDownEdge', 'downEdge'],
        ['isUpEdge', 'upEdge'],
        ['isDecide', 'decide'],
      ] as const) {
        const error = argumentError(name);
        this.vm.bind(name, (args) => {
          const key = args[0];
          if (typeof key !== 'number') {
            host.reportError!(error);
            return [];
          }
          return [input.query(kind, nativeInt(key))];
        });
      }
      const overrideError = argumentError('overrideKey');
      this.vm.bind('overrideKey', (args) => {
        const table = args[0];
        if (!(table instanceof Map)) {
          host.reportError!(overrideError);
          return [];
        }
        // Only number fields count; other field types leave the default.
        const field = (name: string) => {
          const value = table.get(name);
          return typeof value === 'number' ? nativeInt(value) : undefined;
        };
        if (!input.override(field('key'), field('status'))) host.reportError!(overrideError);
        return [];
      });
    }
    if (host.restoreFontCache && host.reportError) {
      this.vm.bind('restoreFontCache', (args) => {
        if (!(args[0] instanceof Uint8Array)) {
          host.reportError!(argumentError('restoreFontCache'));
          return [false];
        }
        return [host.restoreFontCache!(luaText(args[0])) === 'suspended'];
      });
    }
    if (host.scriptStatus && host.setScriptStatus && host.reportError) {
      this.vm.bind('getScriptStatus', () => [host.scriptStatus!()]);
      const error = argumentError('setScriptStatus');
      this.vm.bind('setScriptStatus', (args) => {
        const mode = args[0];
        if (typeof mode !== 'number') host.reportError!(error);
        else host.setScriptStatus!(nativeInt(mode));
        return [];
      });
    }
    if (host.frameNumber) this.vm.bind('getFrameNumber', () => [host.frameNumber!() & 0x7fffffff]);
    if (host.touch && host.reportError) {
      const touch = host.touch;
      this.vm.bind('getTouchCount', () => [touch.count() | 0]);
      const error = argumentError('setUseTouchHold');
      this.vm.bind('setUseTouchHold', (args) => {
        const enabled = args[0];
        if (typeof enabled !== 'boolean') host.reportError!(error);
        else touch.setHold(enabled);
        return [];
      });
    }
    if (host.random)
      this.vm.bind('random', () => {
        const value = host.random!();
        if (!Number.isInteger(value) || value < 0 || value > 0xffff)
          throw Error('Invalid Artemis random value');
        return [value];
      });
    if (host.scriptWaitReason)
      this.vm.bind('getScriptWaitReason', () => {
        const reason = host.scriptWaitReason!();
        const table: LuaTable = new Map();
        // b94 is pushed as (double)(uint32).
        if (reason.time !== undefined) table.set('time', reason.time >>> 0);
        if (reason.textTween) table.set('textTween', 1);
        if (reason.textClearTween) table.set('textClearTween', 1);
        if (reason.sound) table.set('sound', reason.sound);
        if (reason.video) table.set('video', reason.video);
        return [table];
      });
    if (host.readResource && host.reportError)
      // With a coroutine owner it returns (suspended, result) and the wrapper below repeats
      // suspended calls.
      this.vm.bind('loadPngComments', (args) => {
        const value = args[0];
        const result = (table: LuaTable | null) =>
          host.suspendableTags ? [false, table] : [table];
        const report = (message: Uint8Array) => {
          host.reportError!(message);
          return result(null);
        };
        // luabind type 4: only Lua strings; numbers are not converted.
        if (!(value instanceof Uint8Array)) return report(artemisLuaErrors.pngCommentsArgument);
        const nul = value.indexOf(0);
        const bytes = host.readResource!(luaText(nul < 0 ? value : value.subarray(0, nul)));
        if (bytes === 'suspended') {
          if (!host.suspendableTags)
            throw new Error('Artemis resource read suspension requires a coroutine owner');
          return [true];
        }
        if (bytes === null) return report(artemisLuaErrors.pngCommentsMissing);
        const comments = readArtemisPngComments(bytes);
        if (!comments) return report(artemisLuaErrors.pngCommentsUnreadable);
        return result(new Map<string | number | boolean, LuaValue>(comments));
      });
    this.vm.bind('file', (args) => [host.readFile(luaText(args[0]))]);
    this.vm.bind('isFileExists', (args) => [host.fileExists(luaText(args[0]))]);
    this.vm.bind('include', (args) => {
      this.include(luaText(args[0]));
      return [];
    });
    this.vm.bind('var', (args) => {
      const value = host.variable(luaText(args[0]));
      return [typeof value === 'string' ? new TextEncoder().encode(value) : value];
    });
    this.vm.bind('tag', (args) => {
      if (host.tag(luaTag(args[0])) === 'suspended') {
        if (!host.suspendableTags)
          throw new Error('Artemis tag suspension requires a coroutine owner');
        return [true];
      }
      return [];
    });
    this.vm.bind('enqueueTag', (args) => {
      host.enqueueTag(luaTag(args[0]));
      return [];
    });
    if (host.emote) this.bindEmote(host.emote);
    if (host.suspendableTags) {
      this.vm.bind('artemisIncludeSource', (args) => {
        const path = luaText(args[0]);
        if (args[1] === true) {
          try {
            const original = host.readPlainFile?.(path) ?? null;
            const raw =
              original === null ? null : (host.prepareIncludeSource?.(path, original) ?? original);
            return raw === null
              ? [null]
              : [
                  luaFileBytes(raw, windowsTextFileBytes(raw)),
                  new TextEncoder().encode(`@${path}`),
                ];
          } catch (error) {
            if (!this.vm.usable) throw error;
            return [null];
          }
        }
        const original = host.readFile(path);
        return [
          original === null ? null : (host.prepareIncludeSource?.(path, original) ?? original),
          new TextEncoder().encode(path),
        ];
      });
      this.vm.bind('artemisIncludeFailure', (args) => {
        const error = this.vm.errorFromValue(args[1], args[2] === 3 ? 3 : 2);
        if (!this.vm.usable || !host.reportIncludeError) throw error;
        host.reportIncludeError(luaText(args[0]), error);
        return [];
      });
      // Resource failures are raised by a host method so they keep a host cause.
      this.vm.bind('artemisResourceFailure', (args) => {
        const message = args[0];
        throw new Error(
          message instanceof Uint8Array
            ? new TextDecoder().decode(message)
            : 'Artemis resource operation failed',
        );
      });
      this.vm.execute(
        new TextEncoder().encode(`
        local nativeTag = engine.tag
        local resourceFailure = engine.artemisResourceFailure
        engine.artemisResourceFailure = nil
        local includeSource = engine.artemisIncludeSource
        local includeFailure = engine.artemisIncludeFailure
        engine.artemisIncludeSource = nil
        engine.artemisIncludeFailure = nil
        local function pack(...) return {n=select('#', ...), ...} end
        -- A child coroutine supplies the native protected include boundary
        -- without a Lua 5.1 C pcall remaining on the stack across resource waits.
        engine.include = function(self, path)
          local function attempt(plain)
            local source, name = includeSource(self, path, plain)
            if source == nil then return false, 'Missing Artemis Lua include '..path, 3 end
            local chunk, message = loadstring(source, name)
            if not chunk then return false, message, 3 end
            local child = coroutine.create(chunk)
            local args = {n=0}
            while true do
              local result = pack(coroutine.resume(child, unpack(args, 1, args.n)))
              if not result[1] then return false, result[2], 2 end
              if coroutine.status(child) == 'dead' then return true end
              args = pack(coroutine.yield(unpack(result, 2, result.n)))
            end
          end
          if attempt(true) then return end
          local ok, message, status = attempt(false)
          if not ok then
            if type(message) ~= 'string' then message = nil end
            includeFailure(self, path, message, status)
          end
        end
        engine.tag = function(self, command)
          if nativeTag(self, command) then
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end
      ${
        host.readResource && host.reportError
          ? `local nativeLoadPngComments = engine.loadPngComments
        engine.loadPngComments = function(self, path)
          while true do
            local suspended, result = nativeLoadPngComments(self, path)
            if not suspended then return result end
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end`
          : ''
      }
      ${
        host.bindSurface
          ? `local nativeBindSurface = engine.bindSurface
        engine.bindSurface = function(self, name)
          if nativeBindSurface(self, name) then
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end`
          : ''
      }
      ${host.emote ? artemisEmoteLuaPrelude() : ''}
      ${
        host.restoreFontCache
          ? `local nativeRestoreFontCache = engine.restoreFontCache
        engine.restoreFontCache = function(self, path)
          if nativeRestoreFontCache(self, path) then
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end`
          : ''
      }
      `),
        '@artemis/suspendable-tag',
      );
    }
    installArtemisLuaOs(this.vm, host.os, () => (host.wallClock ? host.wallClock() : Date.now()));
  }
  private readonly emotePlayers = new Map<number, EmotePlayer>();
  private emoteHandle = 0;
  /** `getEmoteVersion`, `createEmoteLayer` and `getEmoteLayer` (Rev.3258 0x1401535d0,
   * 0x140151480, 0x140152960). Players reach Lua as handles that the prelude wraps. */
  private bindEmote(emote: ArtemisLuaEmoteHost): void {
    const host = this.host;
    if (!host.suspendableTags || !host.reportError)
      throw Error('Artemis E-mote layers require a coroutine owner and error reports');
    const handle = (player: EmotePlayer) => {
      const id = ++this.emoteHandle;
      this.emotePlayers.set(id, player);
      return id;
    };
    const report = (message: Uint8Array) => {
      host.reportError!(message);
      return null;
    };
    this.vm.bind('getEmoteVersion', () => [new TextEncoder().encode(emote.version)]);
    this.vm.bind('artemisEmoteCreate', (args) => {
      const table = args[0];
      if (!(table instanceof Map)) return [false, report(argumentError('createEmoteLayer'))];
      // Keys and values of another Lua type are skipped.
      let id = '',
        width = 0,
        height = 0,
        progress = true;
      const files: string[] = [];
      for (const [key, value] of table) {
        if (key === 'id' && value instanceof Uint8Array) id = luaText(value);
        else if (key === 'files' && value instanceof Map) {
          for (const file of value.values())
            if (file instanceof Uint8Array) files.push(luaText(file));
        } else if (key === 'width' && typeof value === 'number') width = nativeInt(value);
        else if (key === 'height' && typeof value === 'number') height = nativeInt(value);
        else if (key === 'progress' && typeof value === 'boolean') progress = value;
      }
      const player = emote.createLayer({id, files, width, height, progress});
      if (player === 'suspended') return [true];
      if (player === 'missing') return [false, report(artemisLuaErrors.emoteFileMissing)];
      return [false, handle(player)];
    });
    this.vm.bind('artemisEmoteGet', (args) => {
      const table = args[0];
      if (!(table instanceof Map)) return [report(argumentError('getEmoteLayer'))];
      let id = '',
        next = false;
      for (const [key, value] of table) {
        if (key === 'id' && value instanceof Uint8Array) id = luaText(value);
        else if (key === 'next' && typeof value === 'boolean') next = value;
      }
      // The node's other actor (virtual +0x130) is not modeled.
      if (next) throw Error('Unsupported Artemis getEmoteLayer next layer');
      const player = emote.layer(id);
      if (player === 'not-found') return [report(artemisLuaErrors.layerNotFound)];
      if (player === 'not-emote') return [report(artemisLuaErrors.notEmoteLayer)];
      return [handle(player)];
    });
    this.vm.bind('artemisEmoteCall', (args) => {
      const player = this.emotePlayers.get(args[0] as number);
      if (!player) throw Error('Released Artemis E-mote player handle');
      return callArtemisEmotePlayer(player, luaText(args[1]), args.slice(2));
    });
    this.vm.bind('artemisEmoteRelease', (args) => {
      for (const id of args) this.emotePlayers.delete(id as number);
      return [];
    });
  }
  include(path: string): void {
    if (this.host.readPlainFile) {
      try {
        const original = this.host.readPlainFile(path);
        const plain =
          original === null ? null : (this.host.prepareIncludeSource?.(path, original) ?? original);
        if (plain !== null) {
          this.vm.executeFile(plain, path, windowsTextFileBytes(plain));
          return;
        }
      } catch (error) {
        if (!this.vm.usable) throw error;
        // 12d590 retries on open/load/pcall failure, preserving prior Lua effects.
      }
    }
    const bytes = this.host.readFile(path);
    try {
      if (bytes === null) throw new Error(`Missing Artemis Lua include ${path}`);
      this.vm.execute(this.host.prepareIncludeSource?.(path, bytes) ?? bytes, path); // Packed filename stays literal.
    } catch (error) {
      if (!this.vm.usable || !this.host.reportIncludeError) throw error;
      this.host.reportIncludeError(path, error);
    }
  }
  get suspendableTags(): boolean {
    return this.host.suspendableTags === true;
  }
  call(name: string, args: ReadonlyMap<string, string> = new Map()): void {
    const callback = this.callback(name);
    try {
      callback.invokeVoid(this.callArguments(args), true);
    } finally {
      callback.release();
    }
  }
  /** Resumable counterpart for owners that load resources asynchronously. */
  createCall(name: string, args: ReadonlyMap<string, string> = new Map()): ArtemisLuaCall {
    const callback = this.callback(name);
    try {
      const values = this.callArguments(args);
      return new ArtemisLuaCall(this.vm.createThread(callback, true), values);
    } finally {
      callback.release();
    }
  }
  private callArguments(args: ReadonlyMap<string, string>): LuaValue[] {
    if (!args.size) return [];
    const params: LuaTable = new Map();
    for (const [key, value] of args) params.set(key, new TextEncoder().encode(value));
    return [params];
  }
  /** Native12c030 last-error bytes for a calllua failure it catches, or null when the
   * failure must remain strict. Its luabind::error catch converts a string or nil
   * error value with object_cast<const char*> and assigns up to the first NUL; nil
   * and other values are not recoverable there. Host refusals, VM traps and the web
   * memory cap (status4) are never reported as script errors.
   */
  callErrorMessage(error: unknown): Uint8Array | null {
    if (!this.vm.usable) return null;
    if (error instanceof ArtemisLuaFunctionNotFound) return new TextEncoder().encode(error.message);
    if (!(error instanceof LuaRuntimeError) || error.hostCause !== undefined || !error.value)
      return null;
    if (error.status !== 2 && error.status !== 5) return null;
    const nul = error.value.indexOf(0);
    return nul < 0 ? error.value : error.value.subarray(0, nul);
  }
  /** 12c030 splits on '.', stops at nil/false and requires a Lua function at the end. */
  private callback(name: string): LuaReference {
    const parts = name.split('.');
    if (parts.some((part) => !part)) throw new Error('Invalid Artemis Lua function path');
    let callback = this.vm.referenceGlobal(parts[0]!);
    try {
      for (let index = 1; ; index++) {
        if (callback.type === 0 || (callback.type === 1 && callback.read() === false))
          throw new ArtemisLuaFunctionNotFound(name);
        if (index === parts.length) break;
        const next = callback.get(parts[index]!);
        callback.release();
        callback = next;
      }
      if (callback.type !== 6) throw new ArtemisLuaFunctionNotFound(name);
      return callback;
    } catch (error) {
      callback.release();
      throw error;
    }
  }
  /** Script-origin tags are filtered; direct/queued CLua tags have negative sourceLine and bypass it. */
  filterTag(tag: AsbTag): boolean {
    if (tag.sourceLine < 0 || !this.filter) return false;
    const callback = this.filter.get(tag.name);
    try {
      if (callback.type !== 6) return false;
      const args: LuaTable = new Map();
      for (const [key, value] of tag.args) args.set(key, new TextEncoder().encode(value));
      return artemisTagFilterResult(callback.invokeFirst([args], true));
    } finally {
      callback.release();
    }
  }
  createTagFilterCall(tag: AsbTag): ArtemisLuaCall | null {
    if (tag.sourceLine < 0 || !this.filter) return null;
    const callback = this.filter.get(tag.name);
    try {
      if (callback.type !== 6) return null;
      const params: LuaTable = new Map();
      for (const [key, value] of tag.args) params.set(key, new TextEncoder().encode(value));
      return new ArtemisLuaCall(this.vm.createThread(callback, true), [params], false);
    } finally {
      callback.release();
    }
  }
  /** Native event dispatcher: zero falls through, two fails, other nonzero values consume.
   * The event owner must report callback errors and continue its default dispatch.
   * This is separate from script tag filtering and does not dispatch default actions.
   */
  filterEvent(tag: AsbTag): number {
    if (!tag.name || !this.eventFilter) return 0;
    const args: LuaTable = new Map();
    for (const [key, value] of tag.args) args.set(key, new TextEncoder().encode(value));
    return artemisEventFilterResult(
      this.eventFilter.invokeFirst([new TextEncoder().encode(tag.name), args], true),
    );
  }
  /** Resumable counterpart of `filterEvent` for owners that hold the frame while a tag of the
   * filter loads resources; its first result goes through `artemisEventFilterResult`. Null
   * without an event filter or for an unnamed event. */
  createEventFilterCall(tag: AsbTag): ArtemisLuaCall | null {
    if (!tag.name || !this.eventFilter) return null;
    const args: LuaTable = new Map();
    for (const [key, value] of tag.args) args.set(key, new TextEncoder().encode(value));
    return new ArtemisLuaCall(
      this.vm.createThread(this.eventFilter, true),
      [new TextEncoder().encode(tag.name), args],
      false,
    );
  }
  close(): void {
    this.vm.close();
  }
}

/** 12c030 resolution failure. The message is the native last-error literal at0x140375638;
 * the UTF-8 form corresponds to its converting branch for the engine text flag.
 */
export class ArtemisLuaFunctionNotFound extends Error {
  constructor(readonly functionName: string) {
    super('指定されたfunctionが見つかりません');
    this.name = 'ArtemisLuaFunctionNotFound';
  }
}

/** The resource owner resumes with no values after success, or false/error bytes after failure. */
export class ArtemisLuaCall {
  private started = false;
  constructor(
    private readonly thread: LuaThread,
    private readonly initialArgs: readonly LuaValue[],
    private readonly discardDoneValues = true,
  ) {}
  resume(values: readonly LuaValue[] = []): LuaThreadResult {
    if (!this.started && values.length)
      throw new Error('Artemis call arguments are already captured');
    const args = this.started ? values : this.initialArgs;
    this.started = true;
    return this.thread.resume(args, this.discardDoneValues, this.discardDoneValues ? Infinity : 1);
  }
  close(): void {
    this.thread.close();
  }
}

/** The native 32-bit event filter result; numeric strings and other values are rejected. */
export function artemisEventFilterResult(result: LuaValue | undefined): number {
  if (
    typeof result !== 'number' ||
    !Number.isFinite(result) ||
    !Number.isSafeInteger(Math.trunc(result))
  )
    throw new Error('Unsupported Artemis event filter result');
  return Math.trunc(result) | 0;
}

export function artemisTagFilterResult(result: LuaValue | undefined): boolean {
  if (
    typeof result !== 'number' ||
    !Number.isFinite(result) ||
    !Number.isSafeInteger(Math.trunc(result))
  )
    throw new Error('Invalid Artemis tag filter result');
  return (Math.trunc(result) | 0) !== 0;
}

/** CLua 0x1401304d0: name at [1], named strings and floorf numeric values. Other keys
 * (numeric keys besides 1, booleans, tables) and values of other Lua types are skipped. */
export function luaTag(value: LuaValue | undefined): AsbTag {
  if (!(value instanceof Map)) throw new Error('Expected Artemis Lua tag table');
  const table = value as LuaTable,
    name = luaText(table.get(1));
  const args = new Map<string, string>(),
    bytes = new Map<string, Uint8Array>();
  for (const [key, item] of table) {
    if (typeof key !== 'string') continue;
    if (item instanceof Uint8Array) {
      // 0x140139920 copies lua_tostring/lua_objlen bytes, so binary data (Pluto) survives.
      bytes.set(key, item);
      args.set(key, tagText(item));
    } else if (typeof item === 'number') {
      const n = Math.floor(Math.fround(item));
      if (!Number.isFinite(n) || n < -0x80000000 || n > 0x7fffffff)
        throw new Error('Unsupported Artemis tag number');
      args.set(key, String(n));
    }
  }
  return {kind: 'tag', name, args, bytes, sourceLine: -1};
}

const strictText = new TextDecoder('utf-8', {fatal: true}),
  lossyText = new TextDecoder('utf-8');
/** Text view of a byte argument; text consumers of binary data see replacement characters. */
function tagText(bytes: Uint8Array): string {
  try {
    return strictText.decode(bytes);
  } catch {
    return lossyText.decode(bytes);
  }
}
