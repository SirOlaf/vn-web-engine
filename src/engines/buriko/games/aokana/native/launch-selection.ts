import {AokanaPathFileDirectory} from './path-file-directory.js';
import {terminatedNativeBytes, type AokanaProgramFiles} from './program-files.js';
import type {AokanaMountedProgramPaths} from './program-paths.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {copyText, textByte, textBytes, type AokanaNativeText} from './text.js';

const CAPACITY = 784;
const DOT = Uint8Array.of(46, 0);
const SYSTEM_ARCHIVE = new TextEncoder().encode('system.arc\0');
const INITIAL_MODULE = new TextEncoder().encode('ipl._bp\0');
const LAUNCHER_TOKEN = new TextEncoder().encode('Execute as a launcher.\0');
const NO_MUTEX_TOKEN = new TextEncoder().encode('Do not use mutex.\0');

function equalText(left: Uint8Array, right: Uint8Array): boolean {
  let offset = 0;
  for (;;) {
    const a = textByte(left, offset),
      b = textByte(right, offset);
    if (a !== b) return false;
    if (a === 0) return true;
    offset++;
  }
}

function copyNativeText(destination: Uint8Array, source: Uint8Array): void {
  const value = textBytes({bytes: source, offset: 0}, true);
  if (value.length > destination.length)
    throw new RangeError('Aokana launch text exceeds its 784-byte native buffer');
  copyText({bytes: destination, offset: 0}, {bytes: source, offset: 0});
}

function combined(first: Uint8Array, second: Uint8Array): Uint8Array {
  const left = textBytes({bytes: first, offset: 0}),
    right = textBytes({bytes: second, offset: 0}),
    result = new Uint8Array(left.length + right.length + 1);
  if (result.length > CAPACITY)
    throw new RangeError('Aokana launch path exceeds its 784-byte native buffer');
  result.set(left);
  result.set(right, left.length);
  return result;
}

/** 06FC10/06FBA0: at most two native byte tokens, not a general shell parser. */
function launchTokens(bytes: Uint8Array): Uint8Array[] {
  const tokens: Uint8Array[] = [];
  let offset = 0;
  while (tokens.length < 2) {
    while (textByte(bytes, offset) === 32) offset++;
    const first = textByte(bytes, offset);
    if (first === 0 || first === 10) break;
    const quoted = first === 34;
    if (quoted) offset++;
    const token: number[] = [];
    for (;;) {
      const value = textByte(bytes, offset);
      if (quoted ? value === 34 : value === 0 || value === 10 || value === 32) break;
      if (value === 0 || value === 10)
        throw new RangeError('Aokana launch token consumed an unclosed native quote');
      if (token.length >= CAPACITY - 1)
        throw new RangeError('Aokana launch token exceeds its 784-byte native buffer');
      token.push(value);
      offset++;
    }
    if (quoted) {
      if (token.length === 0)
        throw new RangeError('Aokana launch parser repeats an empty native quote');
      offset++;
    }
    if (token.length === 0) break;
    tokens.push(Uint8Array.from([...token, 0]));
  }
  return tokens;
}

/** The one BC280 boot-name pair and 06FA50 launch policy over mounted title owners. */
export class AokanaLaunchSelection {
  private readonly pathService: AokanaPathFileDirectory;
  private readonly archiveName = new Uint8Array(CAPACITY); // 1C9150
  private readonly moduleName = new Uint8Array(CAPACITY); // 1C9460
  private primaryStorage: Uint8Array | null = null;
  private saveStorage: Uint8Array | null = null;
  private launcher = 0; // 1E8D08 image bytes
  private mutex = 1; // 1C9ABC image bytes

  constructor(
    readonly files: AokanaProgramFiles,
    readonly paths: AokanaMountedProgramPaths,
    readonly resources: AokanaProgramResources,
    readonly errors: AokanaEngineErrors,
    readonly text: AokanaNativeText,
    readonly executablePathWide: string,
    readonly commandLineTailWide: string,
  ) {
    if (
      files.paths !== paths ||
      files.text !== text ||
      resources.files !== files ||
      resources.errors !== errors ||
      errors.files !== files ||
      errors.saveRoot.files !== files
    )
      throw new Error('Aokana launch selection requires the mounted resource and save-root owners');
    this.pathService = new AokanaPathFileDirectory(files);
  }

  get launcherFlag(): number {
    return this.launcher >>> 0;
  }

  get mutexEnabled(): number {
    return this.mutex >>> 0;
  }

  /** 06FA50 consumes the WinMain tail after F87C0's explicit UTF-8 conversion. */
  async configureFromCommandLine(): Promise<void> {
    const tokens = launchTokens(this.text.encodeWide(this.commandLineTailWide, 1));
    await this.selectPathAndModule(tokens[0] ?? DOT, INITIAL_MODULE);
    if (tokens.length === 2) {
      this.launcher = Number(this.launcher !== 0 || equalText(tokens[1]!, LAUNCHER_TOKEN));
      this.mutex = Number(!equalText(tokens[1]!, NO_MUTEX_TOKEN));
    }
  }

  /** BD520: executable-root reset and default names precede path classification. */
  async selectPathAndModule(path: Uint8Array, module: Uint8Array): Promise<void> {
    // Native BD520 runs synchronously. VM-backed caller strings must be fixed
    // before the mounted BC2B0 directory observation yields to another task.
    const selectedPath = terminatedNativeBytes(path).slice();
    const selectedModule = terminatedNativeBytes(module).slice();
    await this.resetRoot(null);
    this.selectNames(SYSTEM_ARCHIVE, selectedModule);
    if (equalText(selectedPath, DOT)) return;
    const widePath = this.text.decodeAuto({bytes: selectedPath, offset: 0});
    const kind = await this.files.pathKindWide(widePath);
    if (kind === null) {
      const [drive, directory, filename, extension] = this.split(selectedPath);
      await this.resetRoot(combined(drive, directory));
      this.selectNames(combined(filename, extension), selectedModule);
      return;
    }
    if (kind === 'directory') {
      await this.resetRoot(selectedPath);
      return;
    }
    const copy = new Uint8Array(CAPACITY);
    copyNativeText(copy, selectedPath);
    const lastSlash = this.lastBackslash(copy);
    if (lastSlash !== null) {
      copy[lastSlash] = 0;
      await this.resetRoot(copy);
      this.selectNames(copy.subarray(lastSlash + 1), selectedModule);
    } else this.selectNames(selectedPath, selectedModule);
  }

  /** BC250 copies current archive and module C strings into separate caller buffers. */
  copyBootNames(archiveOutput: Uint8Array, moduleOutput: Uint8Array): void {
    copyNativeText(archiveOutput, this.archiveName);
    copyNativeText(moduleOutput, this.moduleName);
  }

  private selectNames(archive: Uint8Array, module: Uint8Array): void {
    copyNativeText(this.archiveName, archive);
    copyNativeText(this.moduleName, module);
  }

  private split(path: Uint8Array): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
    const drive = new Uint8Array(CAPACITY),
      directory = new Uint8Array(CAPACITY),
      filename = new Uint8Array(CAPACITY),
      extension = new Uint8Array(CAPACITY);
    this.pathService.splitPath(
      {bytes: drive, offset: 0},
      {bytes: directory, offset: 0},
      {bytes: filename, offset: 0},
      {bytes: extension, offset: 0},
      {bytes: path, offset: 0},
    );
    return [drive, directory, filename, extension];
  }

  private lastBackslash(path: Uint8Array): number | null {
    const mode = this.text.detectEncoding(path);
    let last: number | null = null;
    for (let offset = 0; textByte(path, offset) !== 0;) {
      const character = this.text.readCharacter(path, offset, mode);
      if (character.length === 0)
        throw new RangeError('Aokana launch path has an unsupported native encoding');
      if (character.value === 92) last = offset;
      offset += character.length;
    }
    return last;
  }

  /** BC2B0: write both roots, clear secondary media, attempt cwd, copy save root. */
  private async resetRoot(path: Uint8Array | null): Promise<void> {
    let root: Uint8Array;
    if (path === null) {
      const [drive, directory] = this.split(this.text.encodeWide(this.executablePathWide, 1));
      root = combined(drive, directory);
      // The null branch constructs a wide drive+directory before UTF-8 encoding.
      this.resources.configuration.nativeFileRoot = this.text.decodeBytes(
        textBytes({bytes: root, offset: 0}),
        1,
      );
    } else {
      const original = textBytes({bytes: path, offset: 0});
      if (original.length === 0)
        throw new RangeError('Aokana root reset reads before an empty native path');
      root = new Uint8Array(original.length + (original.at(-1) === 92 ? 1 : 2));
      if (root.length > CAPACITY)
        throw new RangeError('Aokana root exceeds its 784-byte native buffer');
      root.set(original);
      if (original.at(-1) !== 92) root[original.length] = 92;
      this.resources.configuration.nativeFileRoot = this.text.decodeAuto({bytes: root, offset: 0});
    }
    if (this.primaryStorage === null) this.primaryStorage = new Uint8Array(CAPACITY);
    copyNativeText(this.primaryStorage, root);
    this.resources.configuration.primaryRoot = this.primaryStorage;
    const config = this.resources.configuration;
    // BCC10 prefixes relative error-output paths with this same 1E81B0
    // wide root, regardless of SetCurrentDirectoryW's ignored result.
    this.errors.workingDirectory = this.text.encodeWide(config.nativeFileRoot, 1);
    if (config.secondaryRoot.length === 0) config.secondaryRoot = new Uint8Array(CAPACITY);
    config.secondaryRoot[0] = 0;
    config.secondaryMediaPath = '';
    if (await this.files.isDirectoryWide(config.nativeFileRoot))
      this.paths.setCurrentDirectory(config.nativeFileRoot);
    if (this.saveStorage === null) this.saveStorage = new Uint8Array(CAPACITY);
    copyNativeText(this.saveStorage, this.primaryStorage);
    this.errors.saveRoot.bytes = this.saveStorage;
  }
}
