/**
 * Program arguments and the data path (krkrz `base/win32/SysInitImpl.cpp`,
 * `TVPInitProgramArgumentsAndDataPath`, `TVPGetCommandLine`, `TVPSetCommandLine`;
 * `environ/win32/ApplicationSpecialPath.h`).
 *
 * Arguments come, highest priority first, from the command line, the per-user configuration
 * file (`<datapath>\<exe>.cfu`), the configuration file beside the executable (`<exe>.cf`)
 * and the options embedded in the executable (`TEXT` resource 139). Each is a `-name=value`
 * string; a value in quotes is a TJS string literal.
 */
import {parsePeResources} from '../../../formats/pe/resources.js';
import {scanString} from '../tjs2/literals.js';

/** `IDR_OPTION`: the embedded options resource (type `TEXT`). */
export const EMBEDDED_OPTIONS_RESOURCE = 139;

/**
 * `TVPGetEmbeddedOptions`: the lines of the embedded options resource, split at CR LF, CR, LF
 * and stopping at NUL, as narrow strings decoded with the ANSI code page. Null without the
 * resource.
 */
export function readEmbeddedOptions(
  executable: Uint8Array,
  decodeAnsi: (bytes: Uint8Array) => string,
): string[] | null {
  const resource = parsePeResources(executable, ['TEXT']).find(
    (r) => r.id === EMBEDDED_OPTIONS_RESOURCE,
  );
  if (!resource) return null;
  return splitNarrowLines(resource.bytes).map(decodeAnsi);
}

function splitNarrowLines(buf: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0,
    i = 0;
  for (; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === 0x0d && buf[i + 1] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 2;
      i++;
    } else if (c === 0x0d || c === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    } else if (c === 0) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
      break;
    }
  }
  if (start < i) lines.push(buf.subarray(start, i));
  return lines;
}

/**
 * `LoadLinesFromFile`: the lines of a configuration file as `fgets` in text mode returns them,
 * each with its line feed (CR LF read as LF) and at most 1023 bytes.
 */
export function readConfigLines(
  bytes: Uint8Array,
  decodeAnsi: (bytes: Uint8Array) => string,
): string[] {
  const text: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    // Text mode: CR LF becomes LF; Ctrl-Z ends the file.
    if (bytes[i] === 0x1a) break;
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    text.push(bytes[i]!);
  }
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === 0x0a || i - start === 1022) {
      lines.push(decodeAnsi(Uint8Array.from(text.slice(start, i + 1))));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(decodeAnsi(Uint8Array.from(text.slice(start))));
  return lines;
}

/**
 * `TVPParseCommandLineOne`: `-name` → `-name=yes`; a value starting with a quote is parsed as
 * a TJS string literal (escapes, adjacent literals).
 */
export function parseCommandLineOne(option: string): string {
  const eq = option.indexOf('=');
  if (eq < 0) return option + '=yes';
  const name = option.slice(0, eq + 1);
  const q = option[eq + 1];
  if (q === "'" || q === '"') return name + scanString(option, eq + 2, q, false).value;
  return option;
}

/** Lines of a configuration source as options: comments (`;`) skipped, `-` prepended. */
function configOptions(lines: readonly string[] | null): string[] {
  return (lines ?? []).filter((l) => l[0] !== ';').map((l) => parseCommandLineOne('-' + l));
}

/**
 * The argument list (`TVPProgramArguments`) with the lookup and update rules of the native
 * core. `generation` counts changes (`TVPCommandLineArgumentGeneration`).
 */
export class ProgramArguments {
  readonly #list: string[];
  #generation = 1;

  constructor(list: readonly string[]) {
    this.#list = [...list];
  }

  /**
   * `PushAllCommandlineArguments` (options; after a `--` stopper every argument becomes
   * `-argN`; other arguments name the project folder), then configuration sources in decreasing priority.
   */
  static build(commandLine: readonly string[], ...sources: (readonly string[] | null)[]) {
    const list: string[] = [];
    let stopped = false,
      files = 0;
    for (const arg of commandLine) {
      if (stopped) list.push(`-arg${files++}=${arg}`);
      else if (arg === '--') stopped = true;
      else if (arg[0] === '-')
        list.push(parseCommandLineOne(arg.includes('=') ? arg : arg + '=yes'));
    }
    for (const source of sources) list.push(...configOptions(source));
    return new ProgramArguments(list);
  }

  get generation(): number {
    return this.#generation;
  }

  get list(): readonly string[] {
    return this.#list;
  }

  /** `TVPGetCommandLine`: the value of the first argument named `name`, or null. */
  get(name: string): string | null {
    for (const arg of this.#list) {
      if (!arg.startsWith(name)) continue;
      const c = arg[name.length];
      if (c === '=') return arg.slice(name.length + 1);
      if (c === undefined) return 'yes';
    }
    return null;
  }

  /** `TVPSetCommandLine`: replaces the first argument named `name`, else inserts it first. */
  set(name: string, value: string): void {
    const i = this.#list.findIndex(
      (arg) => arg.startsWith(name) && (arg[name.length] === '=' || arg[name.length] === undefined),
    );
    if (i >= 0) this.#list[i] = name + '=' + value;
    else this.#list.unshift(name + '=' + value);
    this.#generation = (this.#generation + 1) >>> 0 || 1;
  }
}

/** Shell folders as `SHGetSpecialFolderPath` and `SHGetKnownFolderPath` return them. */
export interface SpecialFolders {
  /** `CSIDL_PERSONAL` (Documents); the empty string when unavailable. */
  readonly personal: string;
  /** `CSIDL_APPDATA`. */
  readonly appData: string;
  /** `FOLDERID_SavedGames`. */
  readonly savedGames: string;
}

function excludeTrailingBackslash(path: string): string {
  return path.endsWith('\\') ? path.slice(0, -1) : path;
}

/**
 * `ApplicationSpecialPath::GetDataPathDirectory`: the `-datapath` value (default
 * `$(exepath)\savedata`) with its macros expanded, with a trailing backslash. Missing
 * folders fall back to the executable's folder; `$(vistapath)` is the application data folder
 * on NT 6 and later.
 */
export function dataPathDirectory(
  datapath: string,
  executablePath: string,
  folders: SpecialFolders,
  vistaOrLater: boolean,
): string {
  if (datapath === '') datapath = '$(exepath)\\savedata';
  const exepath = executablePath.slice(0, executablePath.lastIndexOf('\\'));
  const personal = excludeTrailingBackslash(folders.personal) || exepath;
  const appdata = excludeTrailingBackslash(folders.appData) || exepath;
  const savedgames = excludeTrailingBackslash(folders.savedGames) || exepath;
  const out = datapath
    .split('$(exepath)')
    .join(exepath)
    .split('$(personalpath)')
    .join(personal)
    .split('$(appdatapath)')
    .join(appdata)
    .split('$(vistapath)')
    .join(vistaOrLater ? appdata : exepath)
    .split('$(savedgamespath)')
    .join(savedgames);
  return out.endsWith('\\') ? out : out + '\\';
}

/** `ChangeFileExt(path, ext)`. */
export function changeFileExt(path: string, ext: string): string {
  const slash = path.lastIndexOf('\\');
  const dot = path.lastIndexOf('.');
  return (dot > slash ? path.slice(0, dot) : path) + ext;
}
