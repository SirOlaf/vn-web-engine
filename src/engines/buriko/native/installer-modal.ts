import type {WindowsInstallerDialogHost} from '../../../platform/windows-installer-dialogs.js';
import type {WindowsTaskbarProgressHost} from '../../../platform/windows-taskbar-progress.js';
import type {BurikoBpThread} from '../bp/state.js';
import type {BurikoEngineDialogs} from './engine-dialogs.js';
import type {BurikoInstallationCall, BurikoInstallationService} from './installation.js';
import {BURIKO_INSTALLER_TITLE} from './installer-dialogs.js';

const quitKey = {bytes: new TextEncoder().encode('AREYOUSUREYOUWANTTOQUIT\0'), offset: 0};

/** C7640's progress dialog and ITaskbarList3 lifetime over the shared installer worker. */
export class BurikoInstallerModal {
  constructor(
    readonly service: BurikoInstallationService,
    readonly host: WindowsInstallerDialogHost,
    readonly taskbar: WindowsTaskbarProgressHost,
    readonly dialogs: BurikoEngineDialogs,
    readonly windowIdentity: object,
  ) {
    if (service.resources.dialogs !== dialogs)
      throw new Error('Buriko installer modal requires the shared graph dialog owner');
  }

  async install(
    thread: BurikoBpThread,
    call: BurikoInstallationCall,
    cancellable: number,
  ): Promise<number> {
    const taskbarLease: {current: ReturnType<WindowsTaskbarProgressHost['createTaskbarList3']>} = {
      current: null,
    };
    let ran = false;
    try {
      const result = await this.dialogs.withNativeModal(() =>
        this.host.runProgress({
          title: BURIKO_INSTALLER_TITLE,
          template: (this.service.localized.language.value & 0x3ff) === 0x11 ? 0x6f : 0x7b,
          cancellable: cancellable !== 0,
          totalFiles: call.fileNames.length,
          requestCancel: async () => {
            const message =
              this.service.localized.lookup(quitKey) ??
              this.service.resources.files.text.encodeWide('Are you sure you want to quit?', 1);
            if ((await this.dialogs.show(message, null, 0x124)) !== 6) return false;
            this.service.setCancellation(1);
            return true;
          },
          run: (report, showModal) => {
            if (ran) throw new Error('Buriko installer progress host ran the worker twice');
            ran = true;
            return this.service.runModal(
              thread,
              call,
              (progress) =>
                report({
                  completedFiles: progress.completedFiles,
                  totalFiles: progress.totalFiles,
                  completedBlocks: progress.completedBlocks,
                  totalBlocks: progress.totalBlocks,
                  fileName:
                    progress.fileName === null
                      ? null
                      : this.service.resources.files.text.decodeAuto({
                          bytes: progress.fileName,
                          offset: 0,
                        }),
                }),
              () => {
                taskbarLease.current = this.taskbar.createTaskbarList3();
                taskbarLease.current?.setProgressState(this.windowIdentity, 2);
                showModal();
              },
            );
          },
        }),
      );
      if (!ran) throw new Error('Buriko installer progress host omitted the worker');
      return result;
    } finally {
      if (taskbarLease.current !== null) {
        try {
          taskbarLease.current.setProgressState(this.windowIdentity, 0);
        } finally {
          taskbarLease.current.release();
        }
      }
    }
  }
}
