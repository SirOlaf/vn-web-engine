import {duplicateWindowsShellPrimaryToken} from '../../../platform/windows-process.js';
import type {WindowsPostTeardownDialogHost} from '../../../platform/windows-post-teardown-dialog.js';
import type {BurikoExitLaunchRequest} from './exit-launch-handoff.js';
import {BurikoExitLaunchHandoff} from './exit-launch-handoff.js';
import {BurikoExternalProcesses, type BurikoExitLaunchProcessPlan} from './external-process.js';

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameRequest(a: BurikoExitLaunchRequest, b: BurikoExitLaunchRequest): boolean {
  return (
    sameBytes(a.baseDirectory, b.baseDirectory) &&
    sameBytes(a.command, b.command) &&
    sameBytes(a.failureMessage, b.failureMessage)
  );
}

/** E1's one-shot C71F0 continuation, independent of every closed engine graph owner. */
export class BurikoAfterTeardownLaunch {
  private consumed = false;

  private constructor(
    private readonly handoff: BurikoExitLaunchHandoff,
    private readonly pending: BurikoExitLaunchRequest,
    private readonly plan: BurikoExitLaunchProcessPlan,
    private readonly dialogs: WindowsPostTeardownDialogHost,
  ) {}

  /** Call after the VM stops, before core.close() or graph.shutdown(). */
  static capture(
    handoff: BurikoExitLaunchHandoff,
    processes: BurikoExternalProcesses,
    dialogs: WindowsPostTeardownDialogHost,
  ): BurikoAfterTeardownLaunch | null {
    const pending = handoff.snapshotPendingForTeardown();
    return pending === null
      ? null
      : new BurikoAfterTeardownLaunch(
          handoff,
          pending,
          processes.prepareExitLaunch(pending),
          dialogs,
        );
  }

  /** Call only after core.close() and graph.shutdown() have completed. */
  async runAfterTeardown(): Promise<0 | 1> {
    if (this.consumed) throw new Error('Buriko exit-and-launch continuation already consumed');
    const pending = this.handoff.takeAfterTeardown();
    this.consumed = true;
    if (pending === null || !sameRequest(this.pending, pending))
      throw new Error('Buriko exit-and-launch request changed during teardown');

    const {host, request, flags} = this.plan;
    // E1 supplies childShow=1 and all remaining C71F0 control flags as zero.
    if (
      flags.childShow !== 1 ||
      flags.toggleMainWindow !== 0 ||
      flags.waitForCompletion !== 0 ||
      flags.retryOnFailure !== 0 ||
      flags.waitForGlobalMutex !== 0
    )
      throw new Error('Buriko exit-and-launch C71F0 flags changed');

    const token =
      this.plan.shellTokenAllowed && (await host.isUserAdministrator())
        ? await duplicateWindowsShellPrimaryToken(host)
        : null;
    try {
      let created = null;
      if (this.plan.mediaAvailable) {
        if (token !== null && this.plan.tokenLaunchAllowed)
          created = await host.createProcessWithTokenW(token, 0, request);
        if (created === null) created = await host.createProcessW(request);
      }
      if (created === null) {
        if (this.plan.failureDialog !== null)
          await this.dialogs.showInformation(
            this.plan.failureDialog.title,
            this.plan.failureDialog.text,
          );
        return 0;
      }
      host.closeHandle(created.thread);
      host.closeHandle(created.process);
      return 1;
    } finally {
      if (token !== null) host.closeHandle(token);
    }
  }
}
