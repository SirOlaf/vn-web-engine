import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoLocalizedMessages} from './localized-messages.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {BurikoSystemProfile} from './system-profile.js';
import {terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';
import {BurikoExternalMutexName} from './external-mutex-name.js';
import type {BurikoExitLaunchRequest} from './exit-launch-handoff.js';
import {duplicateWindowsShellPrimaryToken} from '../../../platform/windows-process.js';
import type {
  WindowsProcessHandle,
  WindowsProcessHost,
  WindowsProcessInformation,
  WindowsProcessRequest,
  WindowsProcessStartup,
  WindowsShellExecuteHost,
} from '../../../platform/windows-process.js';

type BurikoHostResult<T> = T | Promise<T>;

export type BurikoExternalProcessHandle = WindowsProcessHandle;
export type BurikoExternalProcessInformation = WindowsProcessInformation;
/** The native STARTUPINFOW is zeroed before these three nonzero fields are written. */
export interface BurikoExternalProcessStartup extends WindowsProcessStartup {
  readonly cb: 0x68;
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
  readonly standardInput: null;
  readonly standardOutput: null;
  readonly standardError: null;
}
export interface BurikoExternalProcessRequest extends WindowsProcessRequest {
  readonly applicationName: null;
  readonly inheritHandles: false;
  readonly creationFlags: 0;
  readonly currentDirectory: string;
  readonly startup: BurikoExternalProcessStartup;
}
/** Title-specific orchestration uses the shared project-level Win32 primitives. */
export type BurikoExternalProcessHost = WindowsProcessHost;
export type BurikoShellExecuteHost = WindowsShellExecuteHost;

/** Operations from the one actual main-window/message owner. */
export interface BurikoExternalProcessWindowHost {
  readShowState(): number;
  setShowState(value: number): BurikoHostResult<void>;
  pumpMessages(): BurikoHostResult<number>;
}

export interface BurikoExternalProcessCall {
  readonly exitCodeOutput: BurikoBpPointer | null;
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

/** Owned C71F0 inputs that remain valid after the engine graph is released. */
export interface BurikoExitLaunchProcessPlan {
  readonly host: WindowsProcessHost;
  readonly request: BurikoExternalProcessRequest;
  readonly mediaAvailable: boolean;
  readonly shellTokenAllowed: boolean;
  readonly tokenLaunchAllowed: boolean;
  readonly failureDialog: {readonly title: string; readonly text: string} | null;
  readonly flags: {
    readonly childShow: 1;
    readonly toggleMainWindow: 0;
    readonly waitForCompletion: 0;
    readonly retryOnFailure: 0;
    readonly waitForGlobalMutex: 0;
  };
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
): BurikoExternalProcessRequest {
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
export class BurikoExternalProcesses {
  private closed = false;
  private readonly active = new Set<Promise<0 | 1>>();

  constructor(
    private readonly resources: Pick<
      BurikoProgramResources,
      'files' | 'configuration' | 'dialogs' | 'loosePath'
    >,
    private readonly system: Pick<BurikoSystemProfile, 'readVersionRecord'>,
    private readonly localized: Pick<BurikoLocalizedMessages, 'lookup'>,
    private readonly host: BurikoExternalProcessHost,
    private readonly window: BurikoExternalProcessWindowHost,
    /** EA and E2 share DAT_1401eaa50; each OpenMutexA attempt takes a fresh snapshot. */
    readonly mutexName: BurikoExternalMutexName,
    /** Selected synchronous shell impersonation and launch primitives for 80:E3. */
    readonly shellHost: BurikoShellExecuteHost | null = null,
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
  private async duplicateShellPrimaryToken(): Promise<BurikoExternalProcessHandle | null> {
    return duplicateWindowsShellPrimaryToken(this.host);
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

  private prepare(call: BurikoExternalProcessCall): BurikoExternalProcessRequest {
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
        throw new RangeError('Buriko primary root has no trailing byte for a child directory');
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

  /** Snapshot E1's fixed C71F0 call before graph shutdown closes its text/media owners. */
  prepareExitLaunch(request: BurikoExitLaunchRequest): BurikoExitLaunchProcessPlan {
    const flags = {
      childShow: 1,
      toggleMainWindow: 0,
      waitForCompletion: 0,
      retryOnFailure: 0,
      waitForGlobalMutex: 0,
    } as const;
    const prepared = this.prepare({
      exitCodeOutput: null,
      baseDirectory: request.baseDirectory,
      command: request.command,
      currentDirectory: null,
      failureMessage: request.failureMessage,
      ...flags,
    });
    const version = this.version(),
      text = this.resources.files.text,
      titleBytes = this.resources.dialogs.preferredTitle ?? this.resources.dialogs.fallbackTitle;
    return {
      host: this.host,
      request: prepared,
      mediaAvailable: this.resources.files.media.isAvailable(wideText(prepared.commandLine)),
      shellTokenAllowed: version.platform === 2 && version.major >= 5,
      tokenLaunchAllowed: version.major >= 6,
      failureDialog:
        request.failureMessage === null
          ? null
          : {
              title: text.decodeAuto({bytes: terminatedNativeBytes(titleBytes), offset: 0}),
              text: text
                .decodeMixed({
                  bytes: terminatedNativeBytes(request.failureMessage),
                  offset: 0,
                })
                .replace(/\\\\n/g, '\n'),
            },
      flags,
    };
  }

  /** C71F0 waits for the actual named mutex to disappear after its child exits. */
  async waitForGlobalMutex(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      const handle = await this.host.openMutexA(0x1f0001, false, this.mutexName.readAnsiName());
      if (handle === null) return;
      this.host.closeHandle(handle);
      await this.host.sleep(100);
    }
  }

  /** Close admission before the outer VM releases borrowed BP output storage. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return Promise.all(
      [...this.active].map((work) =>
        work.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ).then(() => undefined);
  }

  run(call: BurikoExternalProcessCall): Promise<0 | 1> {
    if (this.closed) throw new Error('Buriko external-process admission is closed');
    return this.track(this.runAccepted(call));
  }

  private track(work: Promise<0 | 1>): Promise<0 | 1> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  /** C7150's 784-WCHAR local and synchronous impersonation/ShellExecute span. */
  openShellPath(pathBytes: Uint8Array): Promise<0 | 1> {
    if (this.closed) throw new Error('Buriko external-process admission is closed');
    if (this.shellHost === null) throw new Error('Buriko shell-execute host is not selected');
    const path = this.resources.files.text.decodeAuto({bytes: pathBytes, offset: 0});
    if (path.length >= 784)
      throw new RangeError('Buriko ShellExecute path exceeds native wide local');
    return this.track(this.openShellPathAccepted(path, this.shellHost));
  }

  private async openShellPathAccepted(path: string, shell: BurikoShellExecuteHost): Promise<0 | 1> {
    const token = (await this.isUserAdministrator())
      ? await this.duplicateShellPrimaryToken()
      : null;
    let liveToken = token;
    let impersonated = false;
    try {
      if (this.closed) return 0;
      if (token !== null) {
        const result = shell.impersonateLoggedOnUser(token);
        if (typeof result !== 'boolean')
          throw new TypeError('Buriko shell impersonation must complete synchronously');
        if (result) impersonated = true;
        else {
          liveToken = null;
          this.host.closeHandle(token);
        }
      }
      const result = shell.shellExecuteW(null, 'open', path, null, null, 1);
      if (typeof result !== 'number' && typeof result !== 'bigint')
        throw new TypeError('Buriko ShellExecuteW must complete synchronously');
      return BigInt.asUintN(32, BigInt(result)) >= 32n ? 1 : 0;
    } finally {
      try {
        if (impersonated) {
          const result = shell.revertToSelf();
          if (typeof result !== 'boolean')
            throw new TypeError('Buriko shell revert must complete synchronously');
        }
      } finally {
        if (liveToken !== null) this.host.closeHandle(liveToken);
      }
    }
  }

  private async runAccepted(call: BurikoExternalProcessCall): Promise<0 | 1> {
    const primaryToken = (await this.isUserAdministrator())
      ? await this.duplicateShellPrimaryToken()
      : null;
    try {
      const request = this.prepare(call),
        canUseTokenLaunch = primaryToken !== null && this.version().major >= 6;
      let created: BurikoExternalProcessInformation | null;
      for (;;) {
        if (this.closed) return 0;
        created = null;
        const wideCommandLine = wideText(request.commandLine);
        if (this.resources.files.media.isAvailable(wideCommandLine)) {
          if (canUseTokenLaunch)
            created = await this.host.createProcessWithTokenW(primaryToken!, 0, request);
          if (created === null) created = await this.host.createProcessW(request);
        }
        if (created !== null) break;
        if (this.closed) return 0;
        if (call.failureMessage === null) return 0;
        if (call.retryOnFailure >>> 0 === 0) {
          await this.resources.dialogs.show(call.failureMessage, null, 0x40);
          return 0;
        }
        if ((await this.resources.dialogs.show(call.failureMessage, null, 0x41)) === 1) continue;
        const confirmation = this.localized.lookup({bytes: quitConfirmationKey, offset: 0});
        if ((await this.resources.dialogs.show(confirmation, null, 0x124)) === 6) return 0;
      }
      let handlesClosed = false;
      const closeCreatedHandles = (): void => {
        if (handlesClosed) return;
        handlesClosed = true;
        this.host.closeHandle(created.thread);
        this.host.closeHandle(created.process);
      };
      try {
        if (call.waitForCompletion >>> 0 === 0) return 1;
        const initialShowState = this.window.readShowState(),
          toggleWindow = call.toggleMainWindow >>> 0 !== 0 && initialShowState >>> 0 !== 0;
        try {
          if (toggleWindow) await this.window.setShowState(0);
          await this.host.waitForInputIdle(created.process, 0xffffffff);
          let waitResult: number;
          do {
            waitResult = (await this.host.waitForSingleObject(created.process, 8)) >>> 0;
            await this.window.pumpMessages();
          } while (waitResult === 0x102);
          if (call.exitCodeOutput !== null) {
            const exitCode = await this.host.readExitCodeProcess(created.process);
            if (exitCode !== null)
              pointerView(call.exitCodeOutput, 4).setUint32(0, exitCode >>> 0, true);
          }
        } finally {
          closeCreatedHandles();
          try {
            if (call.waitForGlobalMutex >>> 0 !== 0) await this.waitForGlobalMutex();
          } finally {
            if (toggleWindow) await this.window.setShowState(1);
          }
        }
        return 1;
      } finally {
        closeCreatedHandles();
      }
    } finally {
      if (primaryToken !== null) this.host.closeHandle(primaryToken);
    }
  }
}
