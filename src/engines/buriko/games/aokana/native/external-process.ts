import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaLocalizedMessages} from './localized-messages.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaSystemProfile} from './system-profile.js';
import {terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';
import {AokanaExternalMutexName} from './external-mutex-name.js';

type AokanaHostResult<T> = T | Promise<T>;

/** Opaque Win32 handle identity supplied by the selected external-process host. */
export interface AokanaExternalProcessHandle {
  readonly aokanaExternalProcessHandle: true;
}

export interface AokanaExternalProcessInformation {
  readonly process: AokanaExternalProcessHandle;
  readonly thread: AokanaExternalProcessHandle;
}

/** The native STARTUPINFOW is zeroed before these three nonzero fields are written. */
export interface AokanaExternalProcessStartup {
  readonly cb: 0x68;
  readonly reserved: null;
  readonly desktop: null;
  readonly title: null;
  readonly x: 0;
  readonly y: 0;
  readonly xSize: 0;
  readonly ySize: 0;
  readonly xCountChars: 0;
  readonly yCountChars: 0;
  readonly fillAttribute: 0;
  readonly flags: 1;
  readonly showWindow: 0 | 5;
  readonly reserved2Size: 0;
  readonly reserved2: null;
  readonly standardInput: null;
  readonly standardOutput: null;
  readonly standardError: null;
}

export interface AokanaExternalProcessRequest {
  readonly applicationName: null;
  /** CreateProcess may modify this inclusive-NUL UTF-16 buffer. */
  readonly commandLine: Uint16Array;
  readonly processAttributes: null;
  readonly threadAttributes: null;
  readonly inheritHandles: false;
  readonly creationFlags: 0;
  readonly environment: null;
  readonly currentDirectory: string;
  readonly startup: AokanaExternalProcessStartup;
}

/**
 * Explicit shell-token, process, wait and kernel-handle boundary. Implementations
 * must consume command buffers synchronously within each creation call; no Node or
 * developer-machine process is an implicit fallback.
 */
export interface AokanaExternalProcessHost {
  isUserAdministrator(): AokanaHostResult<boolean>;
  readShellWindowProcessId(): AokanaHostResult<number | null>;
  openProcess(
    desiredAccess: number,
    inheritHandle: boolean,
    processId: number,
  ): AokanaHostResult<AokanaExternalProcessHandle | null>;
  openProcessToken(
    process: AokanaExternalProcessHandle,
    desiredAccess: number,
  ): AokanaHostResult<AokanaExternalProcessHandle | null>;
  duplicateTokenEx(
    token: AokanaExternalProcessHandle,
    desiredAccess: number,
    securityAttributes: null,
    impersonationLevel: number,
    tokenType: number,
  ): AokanaHostResult<AokanaExternalProcessHandle | null>;
  createProcessWithTokenW(
    token: AokanaExternalProcessHandle,
    logonFlags: number,
    request: AokanaExternalProcessRequest,
  ): AokanaHostResult<AokanaExternalProcessInformation | null>;
  createProcessW(
    request: AokanaExternalProcessRequest,
  ): AokanaHostResult<AokanaExternalProcessInformation | null>;
  waitForInputIdle(
    process: AokanaExternalProcessHandle,
    milliseconds: number,
  ): AokanaHostResult<number>;
  waitForSingleObject(
    process: AokanaExternalProcessHandle,
    milliseconds: number,
  ): AokanaHostResult<number>;
  readExitCodeProcess(process: AokanaExternalProcessHandle): AokanaHostResult<number | null>;
  openMutexA(
    desiredAccess: number,
    inheritHandle: boolean,
    name: Uint8Array,
  ): AokanaHostResult<AokanaExternalProcessHandle | null>;
  sleep(milliseconds: number): AokanaHostResult<void>;
  closeHandle(handle: AokanaExternalProcessHandle): void;
}

/** Required synchronous operations from the one actual main-window/message owner. */
export interface AokanaExternalProcessWindowHost {
  readShowState(): number;
  setShowState(value: number): void;
  pumpMessages(): number;
}

export interface AokanaExternalProcessCall {
  readonly exitCodeOutput: AokanaBpPointer | null;
  readonly baseDirectory: Uint8Array | null;
  readonly command: Uint8Array;
  readonly currentDirectory: Uint8Array | null;
  readonly childShow: number;
  readonly failureMessage: Uint8Array | null;
  readonly toggleMainWindow: number;
  readonly waitForCompletion: number;
  readonly retryOnFailure: number;
  readonly waitForGlobalMutex: number;
}

const exeSeparator = Uint8Array.of(46, 101, 120, 101, 32, 0);
const quitConfirmationKey = new TextEncoder().encode('AREYOUSUREYOUWANTTOQUIT\0');

function wideCommand(value: string): Uint16Array {
  const result = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) result[index] = value.charCodeAt(index);
  return result;
}

function wideText(value: Uint16Array): string {
  let length = value.indexOf(0);
  if (length < 0) length = value.length;
  let result = '';
  for (let offset = 0; offset < length; offset += 0x8000)
    result += String.fromCharCode(...value.subarray(offset, Math.min(offset + 0x8000, length)));
  return result;
}

function processRequest(
  commandLine: string,
  currentDirectory: string,
  childShow: number,
): AokanaExternalProcessRequest {
  return {
    applicationName: null,
    commandLine: wideCommand(commandLine),
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: false,
    creationFlags: 0,
    environment: null,
    currentDirectory,
    startup: {
      cb: 0x68,
      reserved: null,
      desktop: null,
      title: null,
      x: 0,
      y: 0,
      xSize: 0,
      ySize: 0,
      xCountChars: 0,
      yCountChars: 0,
      fillAttribute: 0,
      flags: 1,
      showWindow: childShow >>> 0 === 0 ? 0 : 5,
      reserved2Size: 0,
      reserved2: null,
      standardInput: null,
      standardOutput: null,
      standardError: null,
    },
  };
}

/** C71F0's byte command construction and complete blocking launch/wait owner. */
export class AokanaExternalProcesses {
  constructor(
    private readonly resources: Pick<
      AokanaProgramResources,
      'files' | 'configuration' | 'dialogs' | 'loosePath'
    >,
    private readonly system: Pick<AokanaSystemProfile, 'readVersionRecord'>,
    private readonly localized: Pick<AokanaLocalizedMessages, 'lookup'>,
    private readonly host: AokanaExternalProcessHost,
    private readonly window: AokanaExternalProcessWindowHost,
    /** EA and E2 share DAT_1401eaa50; each OpenMutexA attempt takes a fresh snapshot. */
    readonly mutexName: AokanaExternalMutexName,
  ) {}

  private version(): {major: number; platform: number} {
    const bytes = this.system.readVersionRecord(),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {major: view.getUint32(4, true), platform: view.getUint32(16, true)};
  }

  /** F3BB0 gates the dynamic IsUserAnAdmin call on the shared cached OS record. */
  private async isUserAdministrator(): Promise<boolean> {
    const version = this.version();
    return version.platform === 2 && version.major >= 5 && (await this.host.isUserAdministrator());
  }

  /** F3740 closes the temporary process before testing its token, then closes that token. */
  private async duplicateShellPrimaryToken(): Promise<AokanaExternalProcessHandle | null> {
    const processId = await this.host.readShellWindowProcessId();
    if (processId === null) return null;
    const process = await this.host.openProcess(0x02000000, false, processId >>> 0);
    if (process === null) return null;
    const token = await this.host.openProcessToken(process, 0x02000000);
    this.host.closeHandle(process);
    if (token === null) return null;
    const primary = await this.host.duplicateTokenEx(token, 0x02000000, null, 3, 1);
    this.host.closeHandle(token);
    return primary;
  }

  private splitCommand(command: Uint8Array): {
    executable: Uint8Array;
    argumentsBytes: Uint8Array | null;
  } {
    const text = this.resources.files.text,
      match = text.find({bytes: command, offset: 0}, {bytes: exeSeparator, offset: 0});
    if (match === null)
      return {executable: terminatedNativeBytes(command).slice(), argumentsBytes: null};
    const executable = new Uint8Array(match + 5);
    executable.set(command.subarray(0, match + 4));
    return {
      executable,
      argumentsBytes: terminatedNativeBytes(command.subarray(match + 5)).slice(),
    };
  }

  private buildCommand(executable: Uint8Array, argumentsBytes: Uint8Array | null): Uint8Array {
    const path = textBytes({bytes: executable, offset: 0}),
      argumentsText =
        argumentsBytes === null ? null : textBytes({bytes: argumentsBytes, offset: 0}),
      result = new Uint8Array(
        path.length + (argumentsText === null ? 3 : argumentsText.length + 4),
      );
    let offset = 0;
    result[offset++] = 34;
    result.set(path, offset);
    offset += path.length;
    result[offset++] = 34;
    if (argumentsText !== null) {
      result[offset++] = 32;
      result.set(argumentsText, offset);
    }
    return result;
  }

  private prepare(call: AokanaExternalProcessCall): AokanaExternalProcessRequest {
    const split = this.splitCommand(call.command),
      root = call.baseDirectory ?? this.resources.configuration.primaryRoot,
      resolved = this.resources.loosePath(root, split.executable, call.baseDirectory !== null);
    let directory: Uint8Array;
    if (call.currentDirectory !== null)
      directory = terminatedNativeBytes(call.currentDirectory).slice();
    else if (call.baseDirectory !== null)
      directory = terminatedNativeBytes(call.baseDirectory).slice();
    else {
      directory = terminatedNativeBytes(this.resources.configuration.primaryRoot).slice();
      if (directory.length < 2)
        throw new RangeError('Aokana primary root has no trailing byte for a child directory');
      directory[directory.length - 2] = 0;
      directory = directory.subarray(0, directory.length - 1);
    }
    const commandLine = this.resources.files.text.decodeAuto({
      bytes: this.buildCommand(resolved, split.argumentsBytes),
      offset: 0,
    });
    return processRequest(
      commandLine,
      this.resources.files.text.decodeAuto({bytes: directory, offset: 0}),
      call.childShow,
    );
  }

  /** C71F0 waits for the actual named mutex to disappear after its child exits. */
  async waitForGlobalMutex(): Promise<void> {
    for (;;) {
      const handle = await this.host.openMutexA(0x1f0001, false, this.mutexName.readAnsiName());
      if (handle === null) return;
      this.host.closeHandle(handle);
      await this.host.sleep(100);
    }
  }

  async run(call: AokanaExternalProcessCall): Promise<0 | 1> {
    const primaryToken = (await this.isUserAdministrator())
      ? await this.duplicateShellPrimaryToken()
      : null;
    try {
      const request = this.prepare(call),
        canUseTokenLaunch = primaryToken !== null && this.version().major >= 6;
      let created: AokanaExternalProcessInformation | null;
      for (;;) {
        created = null;
        const wideCommandLine = wideText(request.commandLine);
        if (this.resources.files.media.isAvailable(wideCommandLine)) {
          if (canUseTokenLaunch)
            created = await this.host.createProcessWithTokenW(primaryToken!, 0, request);
          if (created === null) created = await this.host.createProcessW(request);
        }
        if (created !== null) break;
        if (call.failureMessage === null) return 0;
        if (call.retryOnFailure >>> 0 === 0) {
          await this.resources.dialogs.show(call.failureMessage, null, 0x40);
          return 0;
        }
        if ((await this.resources.dialogs.show(call.failureMessage, null, 0x41)) === 1) continue;
        const confirmation = this.localized.lookup({bytes: quitConfirmationKey, offset: 0});
        if ((await this.resources.dialogs.show(confirmation, null, 0x124)) === 6) return 0;
      }
      if (call.waitForCompletion >>> 0 === 0) return 1;
      const initialShowState = this.window.readShowState(),
        toggleWindow = call.toggleMainWindow >>> 0 !== 0 && initialShowState >>> 0 !== 0;
      if (toggleWindow) this.window.setShowState(0);
      await this.host.waitForInputIdle(created.process, 0xffffffff);
      let waitResult: number;
      do {
        waitResult = (await this.host.waitForSingleObject(created.process, 8)) >>> 0;
        this.window.pumpMessages();
      } while (waitResult === 0x102);
      if (call.exitCodeOutput !== null) {
        const exitCode = await this.host.readExitCodeProcess(created.process);
        if (exitCode !== null)
          pointerView(call.exitCodeOutput, 4).setUint32(0, exitCode >>> 0, true);
      }
      this.host.closeHandle(created.thread);
      this.host.closeHandle(created.process);
      if (call.waitForGlobalMutex >>> 0 !== 0) await this.waitForGlobalMutex();
      if (toggleWindow) this.window.setShowState(1);
      return 1;
    } finally {
      if (primaryToken !== null) this.host.closeHandle(primaryToken);
    }
  }
}
