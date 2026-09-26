import {FileError} from '../../../platform/filesystem.js';
import {pop32, push32, type BurikoBpThread} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import {BurikoDirectoryTree} from './directory-tree.js';
import {updateNativeChecksum} from './group-81-hash.js';
import type {BurikoLocalizedMessages} from './localized-messages.js';
import type {BurikoNativeNotifications} from './notification-queue.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import {terminatedNativeBytes} from './program-files.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import {textBytes, textLength} from './text.js';
import type {BurikoBpProcessMessage} from './types.js';
import type {BurikoNativeRegistry} from './windows-registry.js';

const BLOCK_SIZE = 0x10000;
const HKLM = 0xffffffff80000002n;
const REG_SZ = 1;
const KEY_WRITE = 0x20006;
const MANIFEST_NAME = new TextEncoder().encode('uninst.lst\0');
const ERROR_RECORD_NAME = new TextEncoder().encode('@BGIError.txt\0');
const GDB_RECORD_NAME = new TextEncoder().encode('@BGI.gdb\0');
const HVL_NAME = new TextEncoder().encode('BGI.hvl\0');
const TEMPORARY_NAME = new TextEncoder().encode('inst.tmp\0');

export interface BurikoInstallationCall {
  readonly destinationRoot: Uint8Array;
  readonly directories: readonly Uint8Array[];
  readonly fileNames: readonly Uint8Array[];
  readonly groupCounts: Uint32Array;
  readonly mediaProbeNames: readonly Uint8Array[];
  readonly retryMessages: readonly Uint8Array[];
  readonly numberedCount: number;
  readonly numberedFormat: Uint8Array;
  readonly publisher: Uint8Array;
  readonly product: Uint8Array;
  readonly uninstallerName: Uint8Array;
  readonly uninstallerRetryMessage: Uint8Array;
  readonly publishUninstaller?: boolean;
}

export interface BurikoInstallationProgress {
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly completedBlocks: number;
  readonly totalBlocks: number;
  readonly fileName: Uint8Array | null;
}

/** Optional native outer progress receiver; the archive owner is the verified first argument. */
export interface BurikoInstallationProgressReceiver {
  update(
    archives: BurikoProgramResources['archives'],
    completed: number,
    total: number,
  ): void | Promise<void>;
}

interface HvlRecord {
  readonly name: Uint8Array;
  readonly checksum: bigint;
}

interface InstalledRecord {
  readonly relative: Uint8Array;
  readonly mountedPath: string;
}

interface InstallationWorkerMessage {
  readonly code: number;
  readonly value: number;
}

interface InstallationWorkerRecord {
  readonly index: number;
  readonly fileName: Uint8Array;
  readonly destination: Uint8Array;
  readonly sourceRelative: Uint8Array;
  readonly probeRelative: Uint8Array;
  readonly retryMessage: Uint8Array;
}

interface InstallationSource {
  readonly path: Uint8Array;
  readonly mountedPath: string;
}

function nativeString(value: Uint8Array): Uint8Array {
  return terminatedNativeBytes(value).slice();
}

function messageKey(name: string): {bytes: Uint8Array; offset: number} {
  return {bytes: new TextEncoder().encode(name + '\0'), offset: 0};
}

function isExpectedFileError(error: unknown): boolean {
  return error instanceof FileError || error instanceof DOMException;
}

function utf16RegSz(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2),
    view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++)
    view.setUint16(index * 2, value.charCodeAt(index), true);
  return bytes;
}

/** The native format is used for numbered uninstall-manifest entries. */
function formatNumberedEntry(format: string, value: number): string {
  let output = '';
  for (let index = 0; index < format.length;) {
    if (format[index] !== '%') {
      output += format[index++];
      continue;
    }
    if (format[index + 1] === '%') {
      output += '%';
      index += 2;
      continue;
    }
    const start = index++;
    let zero = false;
    if (format[index] === '0') {
      zero = true;
      index++;
    }
    let widthText = '';
    while (
      index < format.length &&
      format.charCodeAt(index) >= 48 &&
      format.charCodeAt(index) <= 57
    )
      widthText += format[index++];
    let precisionText = '';
    if (format[index] === '.') {
      index++;
      while (
        index < format.length &&
        format.charCodeAt(index) >= 48 &&
        format.charCodeAt(index) <= 57
      )
        precisionText += format[index++];
    }
    const conversion = format[index++];
    if (conversion !== 'd' && conversion !== 'i' && conversion !== 'u') {
      output += format.slice(start, index);
      continue;
    }
    let digits = (value >>> 0).toString(10),
      minimum = precisionText === '' ? 0 : Number.parseInt(precisionText, 10);
    if (digits.length < minimum) digits = '0'.repeat(minimum - digits.length) + digits;
    const width = widthText === '' ? 0 : Number.parseInt(widthText, 10);
    if (digits.length < width) digits = (zero ? '0' : ' ').repeat(width - digits.length) + digits;
    output += digits;
  }
  return output;
}

/** One production owner for DCProcInstallation's singleton and its shared worker globals. */
export class BurikoInstallationService {
  private singleton: BurikoInstallationProcess | null = null;
  private readonly installed: InstalledRecord[] = [];
  private hvl: HvlRecord[] = [];
  private worker: Promise<void> | null = null;
  private workerFailure: unknown = null;
  private workerFailed = false;
  private workerActive = false;
  private workerCancellation = 0;
  private finalClosing: Promise<void> | null = null;

  constructor(
    readonly resources: BurikoProgramResources,
    readonly loading: BurikoResourceLoadingState,
    readonly procedures: BurikoProcedureState,
    readonly clock: BurikoNativeClock,
    readonly notifications: BurikoNativeNotifications,
    readonly localized: Pick<BurikoLocalizedMessages, 'lookup' | 'language'>,
    readonly registry: BurikoNativeRegistry,
    readonly progress: BurikoInstallationProgressReceiver | null = null,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  createProcess(
    thread: BurikoBpThread,
    report: ((progress: BurikoInstallationProgress) => void) | null = null,
  ): BurikoInstallationProcess {
    if (this.finalClosing !== null) throw new Error('Buriko installation service is closing');
    return new BurikoInstallationProcess(thread, this, report);
  }

  /** C7640's modal route borrows the same copy/rollback owner as DCProcInstallation. */
  async runModal(
    thread: BurikoBpThread,
    call: BurikoInstallationCall,
    report: (progress: BurikoInstallationProgress) => void,
    ready: () => void = () => {},
  ): Promise<boolean> {
    const process = this.createProcess(thread, report);
    try {
      if ((await process.initialize(call)) !== 0) return false;
      ready();
      while ((await process.poll()) === 0) {
        if (this.worker !== null) await this.worker;
      }
      return pop32(thread) === 0;
    } finally {
      if (this.worker !== null) await this.worker;
      process.dispose();
    }
  }

  /** Stop admitting installer work and retain the owner until its file worker settles. */
  closeAndJoin(): Promise<void> {
    if (this.finalClosing !== null) return this.finalClosing;
    this.workerCancellation = 1;
    this.finalClosing = (async () => {
      const worker = this.worker;
      if (worker !== null) await worker;
    })();
    return this.finalClosing;
  }

  claim(process: BurikoInstallationProcess): boolean {
    if (this.singleton !== null) return false;
    this.singleton = process;
    this.loading.enterProcedure();
    return true;
  }

  release(process: BurikoInstallationProcess): void {
    if (this.singleton !== process) return;
    this.singleton = null;
    this.loading.leaveProcedure();
  }

  resetOperationState(): void {
    this.installed.length = 0;
    this.hvl = [];
    this.worker = null;
    this.workerFailure = null;
    this.workerFailed = false;
    this.workerActive = false;
    this.workerCancellation = 0;
  }

  setCancellation(value: number): void {
    this.workerCancellation = value >>> 0;
  }

  enqueueWorkerMessage(process: BurikoInstallationProcess, code: number, value: number): void {
    process.enqueueWorkerMessage({code: code >>> 0, value: value >>> 0});
  }

  private join(first: Uint8Array, second: Uint8Array, separator = false): Uint8Array {
    return this.resources.loosePath(first, second, separator);
  }

  private mounted(path: Uint8Array): string {
    return this.resources.files.mountedPath(this.resources.files.path(path));
  }

  private localizedMessage(
    name: string,
    fallback: string,
  ): Uint8Array | {bytes: Uint8Array; offset: number} {
    return (
      this.localized.lookup(messageKey(name)) ?? this.resources.files.text.encodeWide(fallback, 1)
    );
  }

  private async showFileError(name: string, fallback: string): Promise<void> {
    await this.resources.dialogs.show(this.localizedMessage(name, fallback), null, 0x10);
  }

  /** 031F40 publishes only one fully read and recognized checksum table. */
  async loadHvl(path: Uint8Array): Promise<0 | 0x80000001 | 0x80000002 | 0x80000003> {
    const opened = await this.resources.files.open(path);
    if (opened.source === null) return 0x80000001;
    let header: Uint8Array;
    try {
      header = await this.resources.files.read(opened.source, 0, 16);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
      return 0x80000002;
    }
    if (header.length !== 16) return 0x80000002;
    const signature = new TextDecoder().decode(header.subarray(0, 8)),
      legacy = signature === 'BHV_____',
      recordSize = legacy ? 0x40 : signature === 'BHV_V2__' ? 0x100 : 0;
    if (recordSize === 0) return 0x80000002;
    const count = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
        12,
        true,
      ),
      storedSize = Math.imul(count, recordSize) >>> 0;
    let stored: Uint8Array;
    try {
      stored = await this.resources.files.read(opened.source, 16, storedSize);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
      return 0x80000003;
    }
    if (stored.length !== storedSize) return 0x80000003;
    const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength),
      records: HvlRecord[] = [];
    for (let index = 0; index < count; index++) {
      const offset = index * recordSize,
        raw = textBytes({bytes: stored, offset}, true).slice(),
        name = this.resources.files.text.convertEncoding({bytes: raw, offset: 0}, 1),
        checksum = view.getBigUint64(offset + (legacy ? 0x38 : 0xf8), true);
      records.push({name, checksum});
    }
    this.hvl = records;
    return 0;
  }

  private expectedChecksum(name: Uint8Array): bigint | null {
    const query = this.resources.files.text
      .decodeAuto({bytes: nativeString(name), offset: 0})
      .toLowerCase();
    for (const record of this.hvl) {
      const candidate = this.resources.files.text
        .decodeAuto({bytes: nativeString(record.name), offset: 0})
        .toLowerCase();
      if (candidate === query) return record.checksum;
    }
    return null;
  }

  mapFileGroup(index: number, counts: Uint32Array): number | null {
    let remaining = index | 0;
    for (let group = 0; group < counts.length; group++) {
      remaining -= counts[group]!;
      if (remaining < 0) return group;
    }
    return null;
  }

  createWorkerRecord(
    call: BurikoInstallationCall,
    sourceFolder: Uint8Array,
    index: number,
  ): InstallationWorkerRecord | null {
    const fileName = call.fileNames[index];
    if (fileName === undefined) return null;
    const group = this.mapFileGroup(index, call.groupCounts);
    if (group === null) return null;
    return {
      index: index >>> 0,
      fileName,
      destination: this.join(call.destinationRoot, fileName, true),
      sourceRelative: this.join(sourceFolder, fileName, true),
      probeRelative: this.join(sourceFolder, call.mediaProbeNames[group]!, true),
      retryMessage: call.retryMessages[group]!,
    };
  }

  private addInstalled(relative: Uint8Array, path: Uint8Array): void {
    this.installed.unshift({relative: nativeString(relative), mountedPath: this.mounted(path)});
  }

  startFileWorker(process: BurikoInstallationProcess, record: InstallationWorkerRecord): void {
    const operation = this.fileWorker(process, record);
    // C9A30 prepends rollback ownership as soon as the real worker exists.
    this.addInstalled(record.fileName, record.destination);
    this.workerFailure = null;
    this.workerFailed = false;
    const task = operation.then(
      (success) => this.enqueueWorkerMessage(process, success ? 2 : 5, record.index),
      (error: unknown) => {
        this.workerFailure = error;
        this.workerFailed = true;
        this.enqueueWorkerMessage(process, 5, record.index);
      },
    );
    this.worker = task;
  }

  async waitWorker(): Promise<void> {
    const worker = this.worker;
    if (worker !== null) await worker;
    this.worker = null;
    if (this.workerFailed) {
      const error = this.workerFailure;
      this.workerFailure = null;
      this.workerFailed = false;
      throw error;
    }
  }

  initializeWorkers(): void {
    this.workerActive = true;
    this.workerCancellation = 0;
  }

  clearWorkers(): void {
    this.workerActive = false;
    this.workerCancellation = 0;
  }

  private normalSourceRoots(): string[] {
    const primary = this.resources.files.path(this.resources.configuration.primaryRoot),
      drive = /^([a-z]):\\/i.exec(primary),
      unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(primary),
      roots: string[] = [];
    if (drive !== null) roots.push(`${drive[1]!.toLowerCase()}:`);
    else if (unc !== null) roots.push(unc[1]!);
    else roots.push(primary.replace(/[\\/]+$/, ''));
    for (let index = 0; index < 26; index++) {
      const type = this.resources.files.media.driveTypes[index]!;
      if (type === 2 || type === 5) roots.push(`${String.fromCharCode(97 + index)}:`);
    }
    return roots;
  }

  private sourceCandidates(
    sourceRelative: Uint8Array,
    probeRelative: Uint8Array,
  ): {source: Uint8Array; probe: Uint8Array}[] {
    const candidates = this.normalSourceRoots().map((root) => {
      const bytes = this.resources.files.text.encodeWide(root, 1);
      return {
        source: this.join(bytes, sourceRelative, true),
        probe: this.join(bytes, probeRelative, true),
      };
    });
    if (
      textLength({
        bytes: terminatedNativeBytes(this.resources.configuration.secondaryRoot),
        offset: 0,
      }) !== 0
    ) {
      const base = this.resources.configuration.secondaryMediaPath.replace(/[\\/]*$/, '\\'),
        source = base + this.resources.files.path(sourceRelative),
        probe = base + this.resources.files.path(probeRelative);
      candidates.push({
        source: this.resources.files.text.encodeWide(source, 1),
        probe: this.resources.files.text.encodeWide(probe, 1),
      });
    }
    return candidates;
  }

  private async candidateExists(path: Uint8Array): Promise<InstallationSource | null> {
    if (!this.resources.files.isAvailable(path)) return null;
    const opened = await this.resources.files.open(path);
    return opened.source === null ? null : {path, mountedPath: opened.mountedPath};
  }

  private async probeExists(path: Uint8Array): Promise<boolean> {
    if (!this.resources.files.isAvailable(path)) return false;
    const metadata = this.resources.files.metadata;
    if (metadata === null) return false;
    try {
      await metadata.stat(this.mounted(path));
      return true;
    } catch (error) {
      if (isExpectedFileError(error)) return false;
      throw error;
    }
  }

  private async locateSource(
    sourceRelative: Uint8Array,
    probeRelative: Uint8Array,
    retryMessage: Uint8Array,
  ): Promise<InstallationSource | null> {
    for (;;) {
      for (let pass = 0; pass < 20; pass++) {
        for (const candidate of this.sourceCandidates(sourceRelative, probeRelative)) {
          if (!(await this.probeExists(candidate.probe))) continue;
          const source = await this.candidateExists(candidate.source);
          if (source !== null) return source;
        }
        await this.sleep(50);
      }
      const answer = await this.resources.dialogs.show(retryMessage, null, 0x41);
      if (answer !== 2) continue;
      const confirmation = this.localizedMessage(
        'AREYOUSUREYOUWANTTOQUIT',
        'Are you sure you want to quit?',
      );
      if ((await this.resources.dialogs.show(confirmation, null, 0x124)) === 6) return null;
    }
  }

  private temporaryPath(destination: Uint8Array): Uint8Array {
    const path = this.resources.files.path(destination),
      slash = path.lastIndexOf('\\'),
      directory = slash < 0 ? '' : path.slice(0, slash + 1);
    return this.resources.files.text.encodeWide(
      directory + this.resources.files.path(TEMPORARY_NAME),
      1,
    );
  }

  private async deleteIfPresent(path: Uint8Array): Promise<void> {
    const metadata = this.resources.files.metadata;
    if (metadata === null) return;
    try {
      const mounted = this.mounted(path),
        attributes = await metadata.getAttributes(mounted);
      if (attributes !== null) await metadata.setAttributes(mounted, attributes & ~3);
      await metadata.deleteFile(mounted);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
    }
  }

  private async clearReplaceAttributes(path: Uint8Array): Promise<void> {
    const metadata = this.resources.files.metadata;
    if (metadata === null) return;
    try {
      const mounted = this.mounted(path),
        attributes = await metadata.getAttributes(mounted);
      if (attributes !== null) await metadata.setAttributes(mounted, attributes & ~3);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
    }
  }

  private async copyAttempt(
    process: BurikoInstallationProcess,
    record: InstallationWorkerRecord,
    source: InstallationSource,
    sourceTimes: {creationTime: bigint; accessTime: bigint; writeTime: bigint},
    temporary: Uint8Array,
  ): Promise<'success' | 'checksum' | 'failure'> {
    const output = await this.resources.files.createOutput(temporary);
    if (output === null) {
      await this.showFileError('UNABLETOCREATEFILE', 'Unable to create file.');
      return 'failure';
    }
    const reopened = await this.resources.files.open(source.path);
    if (reopened.source === null) {
      output.close();
      await this.showFileError('FILEREADINGFAILED', 'File reading failed.');
      return 'failure';
    }
    const totalBlocks = Math.ceil(reopened.source.size / BLOCK_SIZE) >>> 0,
      checksum = new Uint8Array(8);
    this.enqueueWorkerMessage(process, 3, totalBlocks);
    for (let block = 0; block < totalBlocks; block++) {
      if (!this.workerActive) {
        output.close();
        return 'failure';
      }
      if (this.workerCancellation !== 0) {
        this.workerCancellation = 0;
        const confirmation = this.localizedMessage(
          'AREYOUSUREYOUWANTTOQUIT',
          'Are you sure you want to quit?',
        );
        if ((await this.resources.dialogs.show(confirmation, null, 0x124)) === 6) {
          output.close();
          return 'failure';
        }
      }
      const offset = block * BLOCK_SIZE,
        length = Math.min(BLOCK_SIZE, reopened.source.size - offset);
      let bytes: Uint8Array;
      try {
        bytes = await this.resources.files.read(reopened.source, offset, length);
      } catch (error) {
        if (!isExpectedFileError(error)) throw error;
        output.close();
        await this.showFileError('FILEREADINGFAILED', 'File reading failed.');
        return 'failure';
      }
      if (bytes.length !== length) {
        output.close();
        await this.showFileError('FILEREADINGFAILED', 'File reading failed.');
        return 'failure';
      }
      if ((await output.write(bytes)) !== length) {
        output.close();
        await this.showFileError('FILESAVINGFAILED', 'File saving failed.');
        return 'failure';
      }
      updateNativeChecksum({bytes: checksum, offset: 0}, {bytes, offset: 0}, bytes.length);
      const completedBlock = block + 1;
      this.enqueueWorkerMessage(process, 4, completedBlock);
      await this.progress?.update(
        this.resources.archives,
        (record.index * totalBlocks + completedBlock) >>> 0,
        Math.imul(totalBlocks, process.totalFiles) >>> 0,
      );
    }
    const expected = this.expectedChecksum(record.fileName),
      actual = new DataView(checksum.buffer).getBigUint64(0, true);
    if (expected !== null && expected !== actual) {
      output.close();
      return 'checksum';
    }
    const metadata = this.resources.files.metadata;
    if (metadata === null) {
      output.close();
      return 'failure';
    }
    const mountedTemporary = this.mounted(temporary),
      mountedDestination = this.mounted(record.destination);
    await metadata.setTimes(mountedTemporary, sourceTimes);
    const temporaryAttributes = await metadata.getAttributes(mountedTemporary);
    if (temporaryAttributes !== null)
      await metadata.setAttributes(mountedTemporary, temporaryAttributes & ~3);
    output.close();
    try {
      const destinationAttributes = await metadata.getAttributes(mountedDestination);
      if (destinationAttributes !== null)
        await metadata.setAttributes(mountedDestination, destinationAttributes & ~3);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
    }
    try {
      await metadata.replaceFile(mountedTemporary, mountedDestination);
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
      await this.showFileError('FILESAVINGFAILED', 'File saving failed.');
      return 'failure';
    }
    return 'success';
  }

  private async fileWorker(
    process: BurikoInstallationProcess,
    record: InstallationWorkerRecord,
  ): Promise<boolean> {
    const source = await this.locateSource(
      record.sourceRelative,
      record.probeRelative,
      record.retryMessage,
    );
    if (source === null) return false;
    const metadata = this.resources.files.metadata;
    if (metadata === null) return false;
    const sourceTimes = await metadata.getTimes(source.mountedPath);
    if (sourceTimes === null)
      throw new Error('Buriko installation source has no selected mounted FILETIME metadata');
    const mountedDestination = this.mounted(record.destination);
    try {
      const destination = await metadata.stat(mountedDestination),
        destinationTimes = await metadata.getTimes(mountedDestination);
      if (
        destination.kind === 'file' &&
        destination.size !== 0 &&
        destinationTimes !== null &&
        destinationTimes.writeTime >= sourceTimes.writeTime
      )
        return true;
    } catch (error) {
      if (!isExpectedFileError(error)) throw error;
    }

    const temporary = this.temporaryPath(record.destination);
    try {
      await this.clearReplaceAttributes(temporary);
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await this.copyAttempt(process, record, source, sourceTimes, temporary);
        if (result === 'success') return true;
        if (result === 'failure') return false;
      }
      const template = this.localizedMessage(
          'INSTALLATIONFILEISCORRUPTED',
          'Installation file %s is corrupted.',
        ),
        decoded =
          template instanceof Uint8Array
            ? this.resources.files.text.decodeMixed({bytes: template, offset: 0})
            : this.resources.files.text.decodeMixed(template),
        filename = this.resources.files.path(record.fileName),
        message = this.resources.files.text.encodeWide(decoded.replace(/%s/g, filename), 1);
      await this.resources.dialogs.show(message, null, 0x10);
      return false;
    } finally {
      await this.deleteIfPresent(temporary);
    }
  }

  private normalizeManifestEntry(value: Uint8Array): Uint8Array | null {
    let offset = 0;
    while (value[offset] === 9 || value[offset] === 32) offset++;
    if (offset >= value.length || value[offset] === 0) return null;
    const source = new Uint8Array(value.length - offset + 1);
    source.set(value.subarray(offset));
    const converted = this.resources.files.text.convertEncoding({bytes: source, offset: 0}, 1);
    this.resources.files.text.lowercase({bytes: converted, offset: 0});
    return converted;
  }

  private addManifestEntry(list: Uint8Array[], keys: Set<string>, value: Uint8Array): void {
    const normalized = this.normalizeManifestEntry(
      textBytes({bytes: nativeString(value), offset: 0}),
    );
    if (normalized === null) return;
    const key = Array.from(textBytes({bytes: normalized, offset: 0})).join(',');
    if (keys.has(key)) return;
    keys.add(key);
    list.push(normalized);
  }

  async writeUninstallList(call: BurikoInstallationCall): Promise<boolean> {
    const normal: Uint8Array[] = [],
      directories: Uint8Array[] = [],
      normalKeys = new Set<string>(),
      directoryKeys = new Set<string>();
    this.addManifestEntry(normal, normalKeys, call.uninstallerName);
    this.addManifestEntry(normal, normalKeys, MANIFEST_NAME);
    this.addManifestEntry(normal, normalKeys, ERROR_RECORD_NAME);
    this.addManifestEntry(normal, normalKeys, GDB_RECORD_NAME);
    const format = this.resources.files.path(call.numberedFormat),
      numberedCount = call.numberedCount | 0;
    for (let index = 0; index < numberedCount; index++)
      this.addManifestEntry(
        normal,
        normalKeys,
        this.resources.files.text.encodeWide('@' + formatNumberedEntry(format, index), 1),
      );
    for (const directory of call.directories)
      this.addManifestEntry(directories, directoryKeys, directory);

    const manifestPath = this.join(call.destinationRoot, MANIFEST_NAME, true),
      existing = await this.resources.files.open(manifestPath);
    if (existing.source !== null) {
      let contents: Uint8Array;
      try {
        contents = await this.resources.files.read(existing.source, 0, existing.source.size);
      } catch (error) {
        if (!isExpectedFileError(error)) throw error;
        contents = new Uint8Array();
      }
      for (let start = 0, index = 0; index <= contents.length; index++) {
        if (
          index !== contents.length &&
          contents[index] !== 10 &&
          contents[index] !== 13 &&
          contents[index] !== 0
        )
          continue;
        const line = contents.subarray(start, index);
        let first = 0;
        while (line[first] === 9 || line[first] === 32) first++;
        if (line[first] === 36)
          this.addManifestEntry(directories, directoryKeys, line.subarray(first + 1));
        else this.addManifestEntry(normal, normalKeys, line.subarray(first));
        if (contents[index] === 0) break;
        if (contents[index] === 13 && contents[index + 1] === 10) index++;
        start = index + 1;
      }
    }
    for (const installed of this.installed)
      this.addManifestEntry(normal, normalKeys, installed.relative);

    const outputBytes: number[] = [];
    for (const entry of normal) outputBytes.push(...textBytes({bytes: entry, offset: 0}), 10);
    for (const entry of directories)
      outputBytes.push(36, ...textBytes({bytes: entry, offset: 0}), 10);
    outputBytes.push(0);
    let success = false;
    try {
      const output = await this.resources.files.createOutput(manifestPath);
      if (output !== null) {
        const contents = Uint8Array.from(outputBytes);
        success = (await output.write(contents)) === contents.length;
        output.close();
      }
      if (!success) {
        const message =
          this.localized.language.value === 0x411
            ? 'アンインストーレーションファイルの出力に失敗しました。'
            : 'Unable to output installation info.';
        await this.resources.dialogs.show(
          this.resources.files.text.encodeWide(message, 1),
          null,
          0x10,
        );
      }
      return success;
    } finally {
      this.addInstalled(MANIFEST_NAME, manifestPath);
    }
  }

  private async copyUninstaller(
    source: InstallationSource,
    destination: Uint8Array,
  ): Promise<boolean> {
    const opened = await this.resources.files.open(source.path);
    if (opened.source === null) return false;
    const output = await this.resources.files.createOutput(destination);
    if (output === null) return false;
    let contents: Uint8Array;
    try {
      contents = await this.resources.files.read(opened.source, 0, opened.source.size);
    } catch (error) {
      output.close();
      if (!isExpectedFileError(error)) throw error;
      return false;
    }
    const written = await output.write(contents);
    output.close();
    return contents.length === opened.source.size && written === contents.length;
  }

  private async locateUninstaller(
    relative: Uint8Array,
    retryMessage: Uint8Array,
  ): Promise<InstallationSource | null> {
    for (;;) {
      for (const root of this.normalSourceRoots()) {
        const candidate = this.join(this.resources.files.text.encodeWide(root, 1), relative, true),
          source = await this.candidateExists(candidate);
        if (source !== null) return source;
      }
      const answer = await this.resources.dialogs.show(retryMessage, null, 0x41);
      let cancelled = false;
      if (answer !== 1) {
        const confirmation = this.localizedMessage(
          'AREYOUSUREYOUWANTTOQUIT',
          'Are you sure you want to quit?',
        );
        cancelled = (await this.resources.dialogs.show(confirmation, null, 0x124)) === 6;
      }
      await this.sleep(200);
      if (cancelled) return null;
    }
  }

  async installUninstaller(
    call: BurikoInstallationCall,
    sourceFolder: Uint8Array,
  ): Promise<boolean> {
    const relative = this.join(sourceFolder, call.uninstallerName, true),
      source = await this.locateUninstaller(relative, call.uninstallerRetryMessage),
      destination = this.join(call.destinationRoot, call.uninstallerName, true);
    if (source === null) return false;
    if (!(await this.copyUninstaller(source, destination))) {
      await this.deleteIfPresent(destination);
      const message =
        this.localized.language.value === 0x411
          ? 'アンインストーラーのコピーに失敗しました。'
          : 'Uninstaller could not be installed.';
      await this.resources.dialogs.show(
        this.resources.files.text.encodeWide(message, 1),
        null,
        0x10,
      );
      return false;
    }

    const product = this.resources.files.path(call.product),
      publisher = this.resources.files.path(call.publisher),
      uninstallerPath = this.resources.files.path(destination),
      quoted = `"${uninstallerPath}"`,
      key = await this.registry.createKey(
        HKLM,
        `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`,
        KEY_WRITE,
      ),
      handle = key.handle ?? 0n;
    await this.registry.setValue(handle, 'DisplayName', REG_SZ, utf16RegSz(product));
    await this.registry.setValue(handle, 'Publisher', REG_SZ, utf16RegSz(publisher));
    await this.registry.setValue(handle, 'UninstallString', REG_SZ, utf16RegSz(quoted));
    await this.registry.setValue(handle, 'DisplayIcon', REG_SZ, utf16RegSz(quoted));
    return true;
  }

  async writeRegistry(call: BurikoInstallationCall): Promise<true> {
    const product = this.resources.files.path(call.product),
      publisher = this.resources.files.path(call.publisher),
      folder = `"${this.resources.files.path(call.destinationRoot)}"`,
      key = await this.registry.createKey(HKLM, `Software\\${publisher}\\${product}`, KEY_WRITE);
    await this.registry.setValue(key.handle ?? 0n, 'InstalledFolder', REG_SZ, utf16RegSz(folder));
    return true;
  }

  async rollback(tree: BurikoDirectoryTree | null): Promise<void> {
    const metadata = this.resources.files.metadata;
    for (const record of this.installed) {
      if (metadata === null) break;
      try {
        const attributes = await metadata.getAttributes(record.mountedPath);
        if (attributes !== null) await metadata.setAttributes(record.mountedPath, attributes & ~3);
        await metadata.deleteFile(record.mountedPath);
      } catch (error) {
        if (!isExpectedFileError(error)) throw error;
      }
    }
    await tree?.removeCreatedDirectories();
  }

  clearOperation(tree: BurikoDirectoryTree | null): void {
    this.hvl = [];
    this.installed.length = 0;
    tree?.dispose();
  }
}

/** DCProcInstallation's owned call snapshot, internal FIFO and scheduler lifecycle. */
export class BurikoInstallationProcess extends BurikoProcedure {
  private readonly ownsSingleton: boolean;
  private readonly workerMessages: InstallationWorkerMessage[] = [];
  private call: BurikoInstallationCall | null = null;
  private sourceFolder: Uint8Array = Uint8Array.of(0);
  private directoryTree: BurikoDirectoryTree | null = null;
  private started = false;
  private finished = false;
  private completedFiles = 0;
  private activeFile: Uint8Array | null = null;
  totalFiles = 0;

  constructor(
    thread: BurikoBpThread,
    private readonly service: BurikoInstallationService,
    private readonly report: ((progress: BurikoInstallationProgress) => void) | null = null,
  ) {
    super(thread, service.procedures, service.clock);
    this.ownsSingleton = service.claim(this);
  }

  private reportProgress(): void {
    this.report?.({
      completedFiles: this.completedFiles,
      totalFiles: this.totalFiles,
      completedBlocks: this.currentCompletedBlock,
      totalBlocks: this.currentTotalBlocks,
      fileName: this.activeFile,
    });
  }

  enqueueWorkerMessage(message: InstallationWorkerMessage): void {
    this.workerMessages.push({code: message.code >>> 0, value: message.value >>> 0});
  }

  private snapshot(call: BurikoInstallationCall): BurikoInstallationCall {
    return {
      destinationRoot: nativeString(call.destinationRoot),
      directories: call.directories.map(nativeString),
      fileNames: call.fileNames.map(nativeString),
      groupCounts: call.groupCounts.slice(),
      mediaProbeNames: call.mediaProbeNames.map(nativeString),
      retryMessages: call.retryMessages.map(nativeString),
      numberedCount: call.numberedCount >>> 0,
      numberedFormat: nativeString(call.numberedFormat),
      publisher: nativeString(call.publisher),
      product: nativeString(call.product),
      uninstallerName: nativeString(call.uninstallerName),
      uninstallerRetryMessage: nativeString(call.uninstallerRetryMessage),
      publishUninstaller: call.publishUninstaller,
    };
  }

  private derivedSourceFolder(primaryRoot: Uint8Array): Uint8Array {
    const source = textBytes({bytes: terminatedNativeBytes(primaryRoot), offset: 0});
    if (source.length < 4) return Uint8Array.of(0);
    const output = new Uint8Array(source.length - 3);
    output.set(source.subarray(3, source.length - 1));
    return output;
  }

  async initialize(
    call: BurikoInstallationCall,
  ): Promise<0 | 0x80000000 | 0x80000001 | 0x80000002> {
    if (!this.ownsSingleton) return 0x80000000;
    const owned = this.snapshot(call),
      tree = new BurikoDirectoryTree(this.service.resources.files);
    this.directoryTree = tree;
    if ((await tree.ensure(owned.destinationRoot)) === 0) {
      await tree.removeCreatedDirectories();
      tree.dispose();
      this.directoryTree = null;
      return 0x80000001;
    }
    for (const directory of owned.directories) {
      if (
        (await tree.ensure(
          this.service.resources.loosePath(owned.destinationRoot, directory, true),
        )) !== 0
      )
        continue;
      await tree.removeCreatedDirectories();
      tree.dispose();
      this.directoryTree = null;
      return 0x80000002;
    }
    this.call = owned;
    this.sourceFolder = this.derivedSourceFolder(this.service.resources.configuration.primaryRoot);
    this.service.resetOperationState();
    await this.service.loadHvl(
      this.service.resources.loosePath(this.service.resources.configuration.primaryRoot, HVL_NAME),
    );
    this.totalFiles = owned.fileNames.length >>> 0;
    this.completedFiles = 0;
    this.activeFile = null;
    this.enqueueWorkerMessage({code: 0, value: 0});
    this.started = true;
    return 0;
  }

  protected override handleMessage(message: BurikoBpProcessMessage): void {
    if (message.code === 2) this.service.setCancellation(1);
  }

  private async advanceWorkerMessages(): Promise<0 | 1 | 2> {
    const call = this.call!;
    let message: InstallationWorkerMessage | undefined;
    while ((message = this.workerMessages.shift()) !== undefined) {
      switch (message.code) {
        case 0:
          this.service.initializeWorkers();
          this.enqueueWorkerMessage({code: 1, value: 0});
          break;
        case 1: {
          const record = this.service.createWorkerRecord(call, this.sourceFolder, message.value);
          if (record === null) this.enqueueWorkerMessage({code: 6, value: 1});
          else {
            this.activeFile = record.fileName;
            this.currentCompletedBlock = 0;
            this.currentTotalBlocks = 0;
            this.reportProgress();
            this.service.startFileWorker(this, record);
            this.service.notifications.push(0xf0000000, message.value, this.totalFiles);
          }
          break;
        }
        case 2:
          await this.service.waitWorker();
          this.completedFiles = (message.value + 1) >>> 0;
          this.reportProgress();
          this.service.notifications.push(0xf0000001, message.value, this.totalFiles);
          this.enqueueWorkerMessage({code: 1, value: (message.value + 1) >>> 0});
          break;
        case 3:
          this.currentTotalBlocks = message.value;
          this.reportProgress();
          break;
        case 4:
          this.currentCompletedBlock = message.value;
          this.reportProgress();
          this.service.notifications.push(
            0xf0000002,
            this.currentCompletedBlock,
            this.currentTotalBlocks,
          );
          break;
        case 5:
          this.enqueueWorkerMessage({code: 6, value: 0});
          break;
        case 6:
          await this.service.waitWorker();
          this.service.clearWorkers();
          this.service.notifications.push(0xf0000003, message.value, 0);
          return message.value === 0 ? 2 : 0;
      }
    }
    return 1;
  }

  private currentTotalBlocks = 0;
  private currentCompletedBlock = 0;

  async poll(): Promise<number> {
    this.consumeMessages();
    if (!this.started) return -1;
    if (!this.canRun()) this.service.setCancellation(1);
    const state = await this.advanceWorkerMessages();
    if (state === 1) return 0;
    let success = state === 0;
    const call = this.call!;
    if (success && call.publishUninstaller !== false)
      success = await this.service.writeUninstallList(call);
    if (success && call.publishUninstaller !== false)
      success = await this.service.installUninstaller(call, this.sourceFolder);
    if (success && call.publishUninstaller !== false)
      success = await this.service.writeRegistry(call);
    if (!success) await this.service.rollback(this.directoryTree);
    push32(this.thread, success ? 0 : 4);
    this.service.clearOperation(this.directoryTree);
    this.directoryTree = null;
    this.finished = true;
    return 1;
  }

  override dispose(): void {
    if (this.ownsSingleton && !this.finished) {
      this.service.setCancellation(1);
      this.service.clearOperation(this.directoryTree);
      this.directoryTree = null;
    }
    this.workerMessages.length = 0;
    this.call = null;
    this.service.release(this);
    super.dispose();
  }
}
